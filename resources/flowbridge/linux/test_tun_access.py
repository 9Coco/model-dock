"""Per-user authorization transport checks with fake sockets and temp files.

No test starts systemd, pkexec, a privileged helper, or a real network route.
"""
import io
import json
import os
from pathlib import Path
import socket
import stat
import struct
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import tun_access as access
import tun_setup as setup


def metadata(mode, uid=0, *, links=1, size=0):
    return SimpleNamespace(st_mode=mode, st_uid=uid, st_nlink=links, st_size=size)


class FakeConnection:
    def __init__(self, uid=1000, body=b''):
        self.uid=uid;self.closed=False;self.sent=[];self.options=[]
        self.stream=io.BytesIO(body);self.shutdowns=[]
    def sendall(self, value):self.sent.append(value)
    def close(self):self.closed=True
    def setsockopt(self,*args):self.options.append(args)
    def settimeout(self,value):self.timeout=value
    def connect(self,path):self.path=path
    def makefile(self,mode):return self.stream
    def shutdown(self,how):self.shutdowns.append(how)
    def getsockopt(self,level,option,size):return struct.pack('3i',123,self.uid,1000)
    def events(self):return [json.loads(item) for item in self.sent]


class FakeProcess:
    def __init__(self, code=None):self.code=code;self.actions=[]
    def poll(self):return self.code
    def terminate(self):self.actions.append('term');self.code=0
    def wait(self,timeout=None):self.actions.append(('wait',timeout));return self.code


class IdentityAndPathTests(unittest.TestCase):
    def test_uid_rejects_noncanonical_input_root_and_unknown_accounts(self):
        with patch.object(access.pwd,'getpwuid',return_value=SimpleNamespace(pw_uid=1000)):
            self.assertEqual(access.parse_uid('1000'),1000)
            for value in (1000,True,'0','-1','1.0','1000;id','../1000','1'*11):
                with self.subTest(value=value), self.assertRaises(access.AccessError):access.parse_uid(value)
        for error in (KeyError('missing'),OverflowError('outside uid range')):
            with patch.object(access.pwd,'getpwuid',side_effect=error), self.assertRaises(access.AccessError):
                access.parse_uid('1000')
        with patch.object(access.pwd,'getpwuid',return_value=SimpleNamespace(pw_uid=1001)), self.assertRaises(access.AccessError):
            access.parse_uid('1000')

    def test_both_path_validators_check_root_owner_permissions_symlinks_and_parents(self):
        target=Path('/opt/modeldock-network/tun_access.py')
        def safe(path):return metadata(stat.S_IFREG|0o644 if path==target else stat.S_IFDIR|0o755)
        for module,function,error in ((access,access.require_root_path,access.AccessError),
                                      (setup,setup.trusted,RuntimeError)):
            with self.subTest(module=module.__name__), patch.object(Path,'lstat',autospec=True,side_effect=safe):
                function(target)
            for bad_path,details in ((Path('/opt'),metadata(stat.S_IFDIR|0o777)),
                                     (target,metadata(stat.S_IFREG|0o644,1000)),
                                     (target,metadata(stat.S_IFLNK|0o777)),
                                     (Path('/opt/modeldock-network'),metadata(stat.S_IFREG|0o644))):
                def unsafe(path):return details if path==bad_path else safe(path)
                with self.subTest(module=module.__name__,path=bad_path), \
                     patch.object(Path,'lstat',autospec=True,side_effect=unsafe), self.assertRaises(error):
                    function(target)

    def test_socket_must_be_owned_by_authorized_uid_and_mode_0600(self):
        with patch.object(access,'require_root_path') as directory:
            with patch.object(Path,'lstat',return_value=metadata(stat.S_IFSOCK|0o600,1000)):
                self.assertEqual(access.validate_socket(1000),access.ACCESS_DIR/'1000.sock')
            directory.assert_called_with(access.ACCESS_DIR,directory=True)
            for details in (metadata(stat.S_IFSOCK|0o666,1000), metadata(stat.S_IFSOCK|0o600,1001),
                            metadata(stat.S_IFREG|0o600,1000),metadata(stat.S_IFSOCK|0o600,1000,links=2)):
                with self.subTest(details=details),patch.object(Path,'lstat',return_value=details),self.assertRaises(access.AccessError):
                    access.validate_socket(1000)

    def test_setup_marker_has_root_private_mode_and_bounded_single_link(self):
        with patch.object(access,'require_root_path'):
            with patch.object(Path,'lstat',return_value=metadata(stat.S_IFREG|0o600,size=len(access.GRANT_CONTENT))):
                self.assertTrue(access.configured(1000))
            for details in (metadata(stat.S_IFREG|0o644), metadata(stat.S_IFREG|0o600,links=2),
                            metadata(stat.S_IFREG|0o600,size=0), metadata(stat.S_IFREG|0o600,size=129)):
                with patch.object(Path,'lstat',return_value=details),self.assertRaises(access.AccessError):
                    access.configured(1000)
        with patch.object(access,'require_root_path',side_effect=FileNotFoundError):
            self.assertFalse(access.configured(1000))

    def test_daemon_requires_exact_root_marker_content(self):
        with tempfile.TemporaryDirectory() as name:
            marker = Path(name) / '1000.enabled'
            with patch.object(access, 'SETUP_DIR', Path(name)), patch.object(access, 'configured', return_value=True):
                self.assertFalse(access.authorized(1000))
                marker.write_bytes(b'x' * len(access.GRANT_CONTENT))
                self.assertFalse(access.authorized(1000))
                marker.write_bytes(access.GRANT_CONTENT)
                self.assertTrue(access.authorized(1000))
        for problem in (PermissionError(), access.AccessError()):
            with patch.object(access, 'configured', side_effect=problem):
                self.assertFalse(access.authorized(1000))

    def test_peer_identity_comes_from_kernel_credentials_and_requires_live_pid(self):
        connection=FakeConnection(uid=1000)
        self.assertEqual(access.peer_uid(connection),1000)
        connection.getsockopt=Mock(return_value=struct.pack('3i',0,1000,1000))
        with self.assertRaises(access.AccessError):access.peer_uid(connection)


class ListenerTests(unittest.TestCase):
    def listener(self):
        listener=Mock()
        listener.family=socket.AF_UNIX
        listener.getsockopt.side_effect=lambda level,option:socket.SOCK_STREAM if option==socket.SO_TYPE else 1
        listener.getsockname.return_value=str(access.socket_path(1000))
        return listener

    def test_requires_own_pid_exactly_one_fd_and_exact_unix_listening_path(self):
        environment={'LISTEN_PID':str(os.getpid()),'LISTEN_FDS':'1'}
        listener=self.listener()
        with patch.object(access.socket,'socket',return_value=listener) as create,patch.object(access,'validate_socket') as validate:
            self.assertIs(access.inherited_listener(1000,environment),listener)
            create.assert_called_once_with(fileno=3);validate.assert_called_once_with(1000)
            listener.settimeout.assert_called_once_with(.2)
        for changes in ({'LISTEN_PID':'1'},{'LISTEN_FDS':'2'},{'LISTEN_FDS':'0'}):
            with patch.object(access.socket,'socket') as create,self.assertRaises(access.AccessError):
                access.inherited_listener(1000,{**environment,**changes})
            create.assert_not_called()
        for defect in ('inet','datagram','not-listening','wrong-path'):
            listener=self.listener()
            if defect=='inet':listener.family=socket.AF_INET
            elif defect=='wrong-path':listener.getsockname.return_value='/tmp/other.sock'
            else:
                listener.getsockopt.side_effect=lambda level,option: (
                    socket.SOCK_DGRAM if defect=='datagram' and option==socket.SO_TYPE else
                    0 if defect=='not-listening' and option==socket.SO_ACCEPTCONN else
                    socket.SOCK_STREAM if option==socket.SO_TYPE else 1)
            with self.subTest(defect=defect),patch.object(access.socket,'socket',return_value=listener),self.assertRaises(access.AccessError):
                access.inherited_listener(1000,environment)
            listener.close.assert_called_once()


class DaemonTests(unittest.TestCase):
    def serve_connections(self,connections,processes,*,grants=None):
        stopping=threading.Event();listener=Mock();pending=iter(connections)
        def accept():
            try:return next(pending),None
            except StopIteration:stopping.set();raise socket.timeout()
        listener.accept.side_effect=accept
        factory=Mock(side_effect=processes)
        with patch.object(access, 'authorized', return_value=True, side_effect=grants):
            access.serve(listener,1000,stopping=stopping,popen=factory)
        listener.close.assert_called_once()
        return factory

    def test_only_authorized_uid_can_spawn_fixed_helper_with_minimal_environment(self):
        stranger=FakeConnection(uid=1001);owner=FakeConnection();process=FakeProcess()
        factory=self.serve_connections([stranger,owner],[process])
        self.assertTrue(stranger.closed);self.assertEqual(stranger.sent,[])
        args,kwargs=factory.call_args
        self.assertEqual(args,([str(access.HELPER)],))
        self.assertIs(kwargs['stdin'],owner);self.assertIs(kwargs['stdout'],owner)
        self.assertEqual(kwargs['stderr'],subprocess.DEVNULL)
        self.assertEqual(kwargs['cwd'],'/');self.assertTrue(kwargs['close_fds'])
        self.assertEqual(kwargs['env'],{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C','PKEXEC_UID':'1000'})
        self.assertNotIn('shell',kwargs)
        self.assertEqual(owner.events()[0],{'event':'access-ready','uid':1000})
        self.assertEqual(owner.events()[-1],{'event':'access-ended','returncode':0})
        self.assertEqual(process.actions[0],'term');self.assertTrue(owner.closed)

    def test_same_uid_without_grant_never_receives_a_helper(self):
        owner = FakeConnection()
        factory = self.serve_connections([owner], [], grants=[False])
        factory.assert_not_called()
        self.assertEqual(owner.events(), [{'event':'access-denied','reason':'grant'}])
        self.assertTrue(owner.closed)

    def test_removing_grant_ends_the_active_helper_gracefully(self):
        owner = FakeConnection()
        process = FakeProcess()
        factory = self.serve_connections([owner], [process], grants=[True, False])
        factory.assert_called_once()
        self.assertEqual(process.actions, ['term', ('wait',25)])
        self.assertEqual(owner.events()[-1], {'event':'access-ended','returncode':0})

    def test_same_uid_second_connection_is_denied_until_exact_child_exits(self):
        first=FakeConnection();second=FakeConnection();process=FakeProcess()
        factory=self.serve_connections([first,second],[process])
        self.assertEqual(factory.call_count,1)
        self.assertEqual(second.events(),[{'event':'access-denied','reason':'busy'}])
        self.assertTrue(second.closed)
        self.assertEqual(process.actions,['term',('wait',25)])

    def test_next_client_is_accepted_only_after_previous_child_has_exited(self):
        first=FakeConnection();second=FakeConnection()
        factory=self.serve_connections([first,second],[FakeProcess(code=0),FakeProcess(code=0)])
        self.assertEqual(factory.call_count,2)
        for connection in (first,second):
            self.assertEqual(connection.events(),[{'event':'access-ready','uid':1000},{'event':'access-ended','returncode':0}])
            self.assertTrue(connection.closed)

    def test_spawn_failure_is_reported_without_keeping_an_active_slot(self):
        first=FakeConnection();second=FakeConnection()
        factory=self.serve_connections([first,second],[OSError('fake spawn denied'),FakeProcess(code=0)])
        self.assertEqual(factory.call_count,2)
        self.assertEqual(first.events()[-1],{'event':'access-ended','returncode':127})
        self.assertTrue(first.closed)


class ClientTransportTests(unittest.TestCase):
    def setUp(self):
        grant = patch.object(access, 'configured', return_value=True)
        self.marker = grant.start()
        self.addCleanup(grant.stop)

    def test_stale_socket_without_grant_requests_initial_authorization(self):
        self.marker.return_value = False
        with patch.object(access.socket, 'socket') as sock, self.assertRaises(access.AccessUnavailable):
            access.connect_service(1000)
        sock.assert_not_called()

    def test_revoked_server_handshake_cannot_expose_a_control_stream(self):
        connection=FakeConnection(uid=0,body=b'{"event":"access-denied","reason":"grant"}\n')
        with patch.object(access,'validate_socket'), patch.object(access.socket,'socket',return_value=connection), self.assertRaises(access.AccessUnavailable):
            access.connect_service(1000)
        self.assertTrue(connection.closed)
        self.assertEqual(connection.sent, [])
    def test_service_peer_must_be_root_before_any_request_is_sent(self):
        connection=FakeConnection(uid=1001,body=b'{"event":"access-ready","uid":1000}\n')
        with patch.object(access,'validate_socket',return_value=Path('/run/modeldock-network-access/1000.sock')), \
             patch.object(access.socket,'socket',return_value=connection),self.assertRaises(access.AccessError):
            access.connect_service(1000)
        self.assertTrue(connection.closed);self.assertEqual(connection.sent,[])

    def test_verified_socket_stream_supports_half_close_and_explicit_exit_status(self):
        connection=FakeConnection(uid=0,body=b'{"event":"access-ready","uid":1000}\n{"event":"stopped","id":1}\n{"event":"access-ended","returncode":0}\n')
        with patch.object(access,'validate_socket',return_value=Path('/run/modeldock-network-access/1000.sock')), \
             patch.object(access.socket,'socket',return_value=connection):
            process=access.connect_service(1000)
        process.stdin.write('{"version":3,"command":"stop","id":1}\n')
        process.stdin.close()
        self.assertEqual(connection.shutdowns,[socket.SHUT_WR])
        self.assertEqual(json.loads(process.stdout.readline())['event'],'stopped')
        self.assertEqual(process.stdout.readline(),'');self.assertEqual(process.wait(.01),0)
        process.stdout.close();self.assertTrue(connection.closed)

    def test_missing_socket_is_unavailable_and_busy_handshake_does_not_send_requests(self):
        with patch.object(access,'validate_socket',side_effect=FileNotFoundError),self.assertRaises(access.AccessUnavailable):
            access.connect_service(1000)
        connection=FakeConnection(uid=0,body=b'{"event":"access-denied","reason":"busy"}\n')
        with patch.object(access,'validate_socket',return_value=Path('/run/modeldock-network-access/1000.sock')), \
             patch.object(access.socket,'socket',return_value=connection),self.assertRaises(access.AccessError):
            access.connect_service(1000)
        self.assertEqual(connection.sent,[]);self.assertTrue(connection.closed)

    def test_nonzero_end_frame_and_unannounced_eof_preserve_failure_status(self):
        for body in (b'{"event":"access-ended","returncode":1}\n', b''):
            with self.subTest(body=body):
                connection=FakeConnection(uid=0,body=body)
                process=access.SocketProcess(connection,connection.stream)
                self.assertEqual(process.stdout.readline(),'')
                self.assertEqual(process.poll(),1)
                self.assertEqual(process.wait(.01),1)
                process.stdout.close()

    def test_boolean_end_status_is_not_accepted_as_successful_process_exit(self):
        connection=FakeConnection(uid=0,body=b'{"event":"access-ended","returncode":false}\n')
        process=access.SocketProcess(connection,connection.stream)
        self.assertIn('access-ended',process.stdout.readline())
        self.assertIsNone(process.poll())
        self.assertEqual(process.stdout.readline(),'')
        self.assertEqual(process.wait(.01),1)
        process.stdout.close()

    def test_handshake_user_identity_requires_exact_integer(self):
        connection=FakeConnection(uid=0,body=b'{"event":"access-ready","uid":true}\n')
        with patch.object(access,'validate_socket',return_value=Path('/run/modeldock-network-access/1.sock')), \
             patch.object(access.socket,'socket',return_value=connection),self.assertRaises(access.AccessError):
            access.connect_service(1)
        self.assertTrue(connection.closed)


class FirstSetupTests(unittest.TestCase):
    def test_invoker_is_nonroot_pkexec_identity_and_cannot_be_supplied_as_target_arg(self):
        with patch.object(setup.os,'geteuid',return_value=0),patch.object(setup.pwd,'getpwuid',return_value=SimpleNamespace(pw_uid=1000)):
            self.assertEqual(setup.invoker({'PKEXEC_UID':'1000'}),1000)
            for value in ('','0','-1','1000;reboot','../1000'):
                with self.subTest(value=value),self.assertRaises(RuntimeError):setup.invoker({'PKEXEC_UID':value})
        with patch.object(setup.os,'geteuid',return_value=1000),self.assertRaises(RuntimeError):
            setup.invoker({'PKEXEC_UID':'1000'})
        with patch.object(setup.sys,'argv',['setup','1001']),self.assertRaises(RuntimeError):setup.main()

    def test_setup_enables_only_calling_uid_socket_and_writes_private_marker(self):
        with tempfile.TemporaryDirectory() as name:
            marker_dir=Path(name)/'markers'
            run=Mock(return_value=SimpleNamespace(returncode=0))
            socket_path=setup.SOCKET_DIR/'1000.sock'
            original=Path.lstat
            def lstat(path,*args,**kwargs):
                if path==socket_path:return metadata(stat.S_IFSOCK|0o600,1000)
                return original(path,*args,**kwargs)
            with patch.object(setup,'SETUP_DIR',marker_dir),patch.object(setup,'trusted'), \
                 patch.object(Path,'lstat',autospec=True,side_effect=lstat):
                setup.enable_user(1000,run=run)
            args,kwargs=run.call_args
            self.assertEqual(args,([str(setup.SYSTEMCTL),'enable','--now','modeldock-network-access@1000.socket'],))
            self.assertEqual(kwargs['stdin'],subprocess.DEVNULL);self.assertEqual(kwargs['cwd'],'/')
            self.assertEqual(kwargs['env'],{'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C','LC_ALL':'C'})
            self.assertNotIn('shell',kwargs)
            marker=marker_dir/'1000.enabled'
            self.assertEqual(marker.read_text(),'flowbridge-access-v1\n')
            self.assertEqual(stat.S_IMODE(marker.stat().st_mode),0o600)

    def test_failed_enable_or_wrong_socket_owner_does_not_record_setup(self):
        with tempfile.TemporaryDirectory() as name,patch.object(setup,'SETUP_DIR',Path(name)/'markers'):
            with self.assertRaises(RuntimeError):
                setup.enable_user(1000,run=Mock(return_value=SimpleNamespace(returncode=1)))
            self.assertFalse(setup.SETUP_DIR.exists())
            with patch.object(setup,'trusted'),patch.object(Path,'lstat',return_value=metadata(stat.S_IFSOCK|0o600,1001)),self.assertRaises(RuntimeError):
                setup.enable_user(1000,run=Mock(return_value=SimpleNamespace(returncode=0)))
            self.assertFalse(setup.SETUP_DIR.exists())


if __name__=='__main__':unittest.main()
