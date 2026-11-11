"""Session-scoped authorization; no real privilege, network or routing changes."""
import json
import threading
import time
import unittest
from unittest.mock import Mock, patch

from relay import Endpoint
import tun_client as client
from test_tun_client import FakeFactory, FakeOpener, FakeProcess, TEST_SECRET


class ReusableStdin:
    def __init__(self, process):
        self.process=process;self.closed=False;self.messages=[];self.pending=''
    def write(self, value):
        if self.closed:raise ValueError('closed')
        self.pending+=value
        while '\n' in self.pending:
            line,self.pending=self.pending.split('\n',1)
            message=json.loads(line);self.messages.append(message)
            if message['command']=='start':
                self.process.identity=message['id'];self.process.on_start(self.process)
            elif message['command']=='stop':self.process.request_stop()
            else:raise AssertionError('unexpected command')
        return len(value)
    def flush(self):pass
    def close(self):
        if not self.closed:
            self.closed=True;self.process.eof_requests+=1
            if self.process.identity and self.process.poll() is None:
                self.process.emit({'event':'stopped','id':self.process.identity})
            self.process.finish(0)


class ReusableProcess(FakeProcess):
    def __init__(self,on_start=None,fail_cleanup=False):
        super().__init__()
        self.stdin=ReusableStdin(self);self.identity=None
        self.eof_requests=0;self.fail_cleanup=fail_cleanup
        self.on_start=on_start or (lambda process:process.emit_ready())
    def emit_ready(self):
        self.emit({'event':'ready','id':self.identity,'api_port':19090,'proxy_port':19091,
                   'api_secret':TEST_SECRET,'interface':'modeldock0'})
    def request_stop(self):
        self.stop_requests+=1
        if self.poll() is not None:return
        if self.fail_cleanup:
            self.emit({'event':'error','id':self.identity,'message':'network cleanup failed'})
            self.finish(1)
        else:
            self.emit({'event':'stopped','id':self.identity})


class ReusableTunClientTests(unittest.TestCase):
    def setUp(self):
        self.preflight=patch.object(client,'_check_installed_helper');self.preflight.start()
        self.controllers=[]
    def tearDown(self):
        for controller,process,_ in self.controllers:
            if process.poll() is None:process.stdin.close()
            if controller._reader:controller._reader.join(.5)
            controller._sampling_stop.set()
            if controller._sampler:controller._sampler.join(.3)
        self.preflight.stop()
    def make(self,process=None,**kwargs):
        process=process or ReusableProcess();factory=FakeFactory(process)
        controller=client.ReusableTunController(Endpoint('10.15.60.93',38473),popen_factory=factory,
            api_opener=FakeOpener(),start_timeout=.3,stop_timeout=.15,poll_interval=.01,api_timeout=.1,**kwargs)
        self.controllers.append((controller,process,factory))
        return controller,process,factory

    def test_three_sessions_use_one_authorization_and_stop_leaves_no_active_session(self):
        controller,process,factory=self.make()
        for number in range(1,4):
            controller.start();self.assertTrue(controller.is_running)
            self.assertEqual(process.stdin.messages[-1],{'version':3,'command':'start','id':number,'host':'10.15.60.93','port':38473})
            controller.stop()
            self.assertTrue(controller.cleanup_confirmed)
            self.assertFalse(controller.needs_cleanup)
            self.assertFalse(controller.is_running)
            self.assertTrue(controller.authorization_open)
            self.assertFalse(process.stdin.closed)
        self.assertEqual(len(factory.calls),1)
        controller.close()
        self.assertTrue(process.stdin.closed)
        self.assertFalse(controller.authorization_open)
        self.assertEqual(process.forced_signals,0)
        self.assertEqual(process.poll(),0)

    def test_start_sends_saved_destination_exceptions_and_stop_stays_unchanged(self):
        addresses = ['172.30.238.94', 'fd77::10']
        controller, process, _ = self.make(bypass_addresses=addresses)
        addresses.clear()
        controller.start()
        self.assertEqual(process.stdin.messages[-1]['bypassAddresses'], ['172.30.238.94', 'fd77::10'])
        controller.stop()
        self.assertEqual(process.stdin.messages[-1], {'version': 3, 'command': 'stop', 'id': 1})

    def test_stop_and_close_without_first_start_never_request_authorization(self):
        controller,_,factory=self.make();controller.stop();controller.close()
        self.assertEqual(factory.calls,[])

    def test_phone_endpoint_can_change_only_after_confirmed_stop(self):
        controller,process,factory=self.make();controller.start()
        with self.assertRaises(client.TunStartError):controller.set_endpoint(Endpoint('10.15.60.94',38474))
        controller.stop();controller.set_endpoint(Endpoint('10.15.60.94',38474));controller.start()
        self.assertEqual(process.stdin.messages[-1]['host'],'10.15.60.94')
        self.assertEqual(process.stdin.messages[-1]['port'],38474)
        self.assertEqual(len(factory.calls),1)
        controller.close()

    def test_close_active_session_cleans_then_releases_lease(self):
        controller,process,_=self.make();controller.start();controller.close()
        self.assertGreaterEqual(process.stop_requests,1)
        self.assertEqual(process.eof_requests,1)
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller.authorization_open)

    def test_failed_cleanup_retains_controller_and_blocks_another_start(self):
        controller,process,factory=self.make(ReusableProcess(fail_cleanup=True));controller.start()
        with self.assertRaises(client.TunStopError) as caught:controller.stop()
        self.assertIs(caught.exception.controller,controller)
        self.assertTrue(controller.needs_cleanup)
        with self.assertRaises(client.TunStartError):controller.start()
        self.assertEqual(len(factory.calls),1)
        self.assertEqual(process.forced_signals,0)

    def test_clean_start_failure_keeps_authorization_for_explicit_retry(self):
        count=[0]
        def begin(process):
            count[0]+=1
            if count[0]==1:
                process.emit({'event':'error','id':process.identity,'message':'phone route unavailable'})
                process.emit({'event':'stopped','id':process.identity})
            else:process.emit_ready()
        controller,process,factory=self.make(ReusableProcess(on_start=begin))
        with self.assertRaises(client.TunStartError) as caught:controller.start()
        self.assertTrue(caught.exception.cleanup_confirmed)
        self.assertTrue(controller.authorization_open)
        controller.start();self.assertTrue(controller.is_running)
        self.assertEqual(len(factory.calls),1);controller.close()

    def test_old_stopped_ack_cannot_complete_a_new_session(self):
        def begin(process):
            if process.identity>1:process.emit({'event':'stopped','id':process.identity-1})
            process.emit_ready()
        controller,_,factory=self.make(ReusableProcess(on_start=begin))
        controller.start();controller.stop();controller.start()
        self.assertTrue(controller.is_running);self.assertFalse(controller.cleanup_confirmed)
        self.assertEqual(len(factory.calls),1);controller.close()

    def test_future_session_state_is_rejected_and_input_is_closed(self):
        def begin(process):process.emit({'event':'ready','id':process.identity+1})
        controller,process,factory=self.make(ReusableProcess(on_start=begin))
        with self.assertRaises(client.TunStartError):controller.start()
        self.assertTrue(process.stdin.closed)
        self.assertEqual(len(factory.calls),1)

    def test_cancelled_initial_authorization_is_not_a_network_cleanup_failure(self):
        def begin(process):process.finish(126)
        controller,process,factory=self.make(ReusableProcess(on_start=begin))
        with self.assertRaises(client.TunStartError) as caught:controller.start()
        self.assertTrue(caught.exception.cleanup_confirmed)
        self.assertIn('取消',str(caught.exception))
        self.assertFalse(controller.needs_cleanup)
        self.assertEqual(len(factory.calls),1)


class PersistentServiceSetupTests(unittest.TestCase):
    def make(self,connector,setup):
        return client.ReusableTunController(Endpoint('10.15.60.93',38473),service_connector=connector,
            setup_runner=setup,api_opener=FakeOpener(),start_timeout=.3,stop_timeout=.15,poll_interval=.01,api_timeout=.1)

    def test_existing_service_never_launches_pkexec_or_setup(self):
        from unittest.mock import Mock
        process=object();connector=Mock(return_value=process);setup=Mock()
        controller=self.make(connector,setup)
        self.assertIs(controller._open_service(),process)
        setup.assert_not_called()

    def test_first_use_setup_is_requested_once_then_connects_to_service(self):
        import tun_access
        from unittest.mock import Mock
        process=object();connector=Mock(side_effect=[tun_access.AccessUnavailable('not set up'),process]);setup=Mock()
        controller=self.make(connector,setup)
        with patch.object(tun_access,'configured',return_value=False):
            self.assertIs(controller._open_service(),process)
        setup.assert_called_once_with()
        self.assertEqual(connector.call_count,2)

    def test_saved_authorization_survives_reopening_gui_without_setup(self):
        from unittest.mock import Mock
        process=object();connector=Mock(return_value=process);setup=Mock()
        first=self.make(connector,setup);second=self.make(connector,setup)
        self.assertIs(first._open_service(),process)
        self.assertIs(second._open_service(),process)
        setup.assert_not_called()

    def test_configured_but_failed_service_does_not_reprompt_for_password(self):
        import tun_access
        from unittest.mock import Mock
        connector=Mock(side_effect=tun_access.AccessUnavailable('offline'));setup=Mock()
        controller=self.make(connector,setup)
        with patch.object(tun_access,'configured',return_value=True):
            with self.assertRaises(client.TunStartError) as caught:controller._open_service()
        self.assertTrue(caught.exception.cleanup_confirmed)
        self.assertIn('无需再次输入密码',str(caught.exception));setup.assert_not_called()

    def test_untrusted_service_never_falls_back_to_install_or_pkexec(self):
        import tun_access
        from unittest.mock import Mock
        connector=Mock(side_effect=tun_access.AccessError('wrong uid'));setup=Mock()
        controller=self.make(connector,setup)
        with self.assertRaises(client.TunStartError) as caught:controller._open_service()
        self.assertTrue(caught.exception.cleanup_confirmed);setup.assert_not_called()

    def test_cancelled_setup_leaves_cached_controller_retryable(self):
        import tun_access
        from unittest.mock import Mock
        connector=Mock(side_effect=tun_access.AccessUnavailable('not configured'))
        setup=Mock(side_effect=client.TunStartError('cancelled setup',cleanup_confirmed=True))
        controller=self.make(connector,setup)
        with patch.object(client,'_check_installed_helper'),patch.object(tun_access,'configured',return_value=False):
            with self.assertRaises(client.TunStartError):controller.start()
        self.assertTrue(controller.cleanup_confirmed)
        self.assertFalse(controller.needs_cleanup)
        controller.set_endpoint(Endpoint('10.15.60.94',38473))
        controller.close()

    def test_recovery_only_uses_existing_service_and_is_idempotent_after_ack(self):
        recovery = FakeProcess(on_init=lambda process: process.request_stop())
        connector, setup = Mock(return_value=recovery), Mock()
        controller = self.make(connector, setup)
        with patch.object(client.subprocess, 'Popen') as popen:
            controller.recover_previous()
            controller.recover_previous()
            controller.close()
            popen.assert_not_called()
        connector.assert_called_once_with()
        setup.assert_not_called()
        self.assertEqual(recovery.stdin.messages, [{'version': 1, 'command': 'recover'}])
        self.assertTrue(controller.cleanup_confirmed)

    def test_close_after_losing_the_active_lease_recovers_over_existing_service(self):
        original = ReusableProcess()
        recovery = FakeProcess(on_init=lambda process: process.request_stop())
        connector, setup = Mock(side_effect=[original, recovery]), Mock()
        controller = self.make(connector, setup)
        with patch.object(client, '_check_installed_helper'), patch.object(client.subprocess, 'Popen') as popen:
            controller.start()
            original.finish(1)
            self.assertTrue(controller._exited.wait(1))
            self.assertFalse(controller.cleanup_confirmed)
            controller.close()
            self.assertTrue(controller.cleanup_confirmed)
            popen.assert_not_called()
        self.assertEqual(recovery.stdin.messages, [{'version': 1, 'command': 'recover'}])
        setup.assert_not_called()

    def test_unavailable_or_untrusted_recovery_service_never_requests_authorization(self):
        import tun_access
        for failure, configured, advice in [
            (tun_access.AccessUnavailable(), False, f'pkexec {client.SETUP_HELPER}'),
            (tun_access.AccessUnavailable(), True, '已有网络授权'),
            (tun_access.AccessError('权限服务身份异常。'), True, '权限服务身份异常'),
        ]:
            with self.subTest(advice=advice):
                recovery = FakeProcess(on_init=lambda process: process.request_stop())
                connector, setup = Mock(side_effect=[failure, recovery]), Mock()
                controller = self.make(connector, setup)
                with patch.object(tun_access, 'configured', return_value=configured), patch.object(client.subprocess, 'Popen') as popen:
                    with self.assertRaises(client.TunStopError) as caught:
                        controller.recover_previous()
                    self.assertIn(advice, str(caught.exception))
                    self.assertIs(caught.exception.controller, controller)
                    self.assertTrue(controller.needs_cleanup)
                    with self.assertRaises(client.TunStartError):
                        controller.start()
                    controller.recover_previous()
                    popen.assert_not_called()
                setup.assert_not_called()
                self.assertTrue(controller.cleanup_confirmed)
                self.assertEqual(recovery.stdin.messages, [{'version': 1, 'command': 'recover'}])

    def test_previous_lease_requires_ack_and_successful_exit(self):
        for ack, code in [(False, 0), (True, 1)]:
            with self.subTest(ack=ack, code=code):
                recovery = FakeProcess(on_init=lambda process: process.request_stop(), stop_ack=ack, stop_code=code)
                controller = self.make(Mock(return_value=recovery), Mock())
                with self.assertRaises(client.TunStopError):
                    controller.recover_previous()
                self.assertFalse(controller.cleanup_confirmed)

    def test_retrying_a_pending_recovery_reuses_the_same_lease(self):
        recovery = FakeProcess(on_init=lambda _: None, ignore_stop=True)
        connector, setup = Mock(return_value=recovery), Mock()
        controller = self.make(connector, setup)
        controller._start_timeout = controller._stop_timeout = .02
        try:
            for _ in range(2):
                with self.assertRaises(client.TunStopError):
                    controller.recover_previous()
            self.assertFalse(controller.cleanup_confirmed)
        finally:
            recovery.emit({'event': 'stopped'})
            recovery.finish(0)
        controller.recover_previous()
        connector.assert_called_once_with()
        setup.assert_not_called()
        self.assertTrue(controller.cleanup_confirmed)

    def test_timed_out_setup_retry_reuses_pending_authentication_process(self):
        from unittest.mock import Mock
        import subprocess
        import tun_access
        controller=client.ReusableTunController(Endpoint('10.15.60.93',38473),start_timeout=.01)
        process=Mock(returncode=None);process.poll.return_value=None
        collecting=threading.Event();release=threading.Event();finished=threading.Event()
        calls=[]
        def communicate(timeout=None):
            calls.append(timeout)
            if timeout is not None:raise subprocess.TimeoutExpired('setup',timeout)
            collecting.set();release.wait(2)
            process.returncode=0;process.poll.return_value=0;finished.set()
            return '', ''
        process.communicate.side_effect=communicate
        with patch.object(tun_access,'require_root_path'),patch.object(client.Path,'stat') as details,patch.object(client.subprocess,'Popen',return_value=process) as popen:
            details.return_value.st_mode=0o100755
            try:
                with self.assertRaises(client.TunStartError):controller._run_initial_setup()
                self.assertTrue(collecting.wait(1))
                with self.assertRaises(client.TunStartError) as caught:controller._run_initial_setup()
                self.assertIn('现有认证窗口',str(caught.exception))
                popen.assert_called_once()
            finally:
                release.set();self.assertTrue(finished.wait(1))
            controller._run_initial_setup()
            popen.assert_called_once()
        self.assertEqual(len(calls),2)
        self.assertIsNone(controller._setup_process)

    def test_setup_uses_fixed_installed_entry_and_sanitizes_failures(self):
        from unittest.mock import Mock
        import subprocess
        import tun_access
        controller=client.ReusableTunController(Endpoint('10.15.60.93',38473))
        process=Mock(returncode=126);process.communicate.return_value=('','not logged')
        with patch.object(tun_access,'require_root_path'),patch.object(client.Path,'stat') as details,patch.object(client.subprocess,'Popen',return_value=process) as popen:
            details.return_value.st_mode=0o100755
            with self.assertRaises(client.TunStartError) as caught:controller._run_initial_setup()
        self.assertTrue(caught.exception.cleanup_confirmed)
        self.assertIn('取消',str(caught.exception))
        self.assertEqual(popen.call_args.args[0],[client.PKEXEC,'--disable-internal-agent',client.SETUP_HELPER])
        self.assertEqual(popen.call_args.kwargs['stdin'],subprocess.DEVNULL)
