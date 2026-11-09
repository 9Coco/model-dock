"""Crash recovery verified only against temporary KDE configuration files."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest


class GuardianTests(unittest.TestCase):
    def test_parent_crash_restores_pending_proxy(self):
        source=Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory(prefix='flowbridge-guardian-') as directory:
            config=Path(directory)
            original=b'[Proxy Settings]\nProxyType=0\nhttpProxy=\n[Keep]\nvalue=unchanged\n'
            (config/'kioslaverc').write_bytes(original)
            code='''
import os,subprocess,sys,time
from pathlib import Path
from system_proxy import DesktopProxyManager
config=Path(sys.argv[1]); source=Path(sys.argv[2])
manager=DesktopProxyManager(config_dir=config,runner=lambda c,**k:subprocess.CompletedProcess(c,0,'',''))
manager.apply('127.0.0.1',54321)
r,w=os.pipe(); a,b=os.pipe()
env=dict(os.environ,DBUS_SESSION_BUS_ADDRESS='unix:path=/nonexistent-flowbridge-test-bus')
guard=subprocess.Popen([sys.executable,str(source/'guardian.py'),'--watch-fd',str(r),'--ready-fd',str(b),'--config-dir',str(config)],pass_fds=(r,b),env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
os.close(r); os.close(b)
assert os.read(a,64)==b'ready\\n'
os.close(a)
print('ready',flush=True)
time.sleep(60)
'''
            parent=subprocess.Popen([sys.executable,'-c',code,str(config),str(source)],cwd=source,env=dict(os.environ,XDG_CURRENT_DESKTOP='KDE'),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            try:
                self.assertEqual(parent.stdout.readline().strip(),'ready')
                self.assertIn(b'127.0.0.1 54321',(config/'kioslaverc').read_bytes())
                parent.kill(); parent.wait(timeout=3)
                deadline=time.monotonic()+8
                while time.monotonic()<deadline:
                    if ((config/'kioslaverc').read_bytes()==original
                            and not (config/'modeldock-network/system-proxy-recovery.json').exists()):
                        break
                    time.sleep(.05)
                self.assertEqual((config/'kioslaverc').read_bytes(),original)
                self.assertFalse((config/'modeldock-network/system-proxy-recovery.json').exists())
            finally:
                if parent.poll() is None:
                    parent.kill(); parent.wait(timeout=3)
                parent.stdout.close(); parent.stderr.close()


if __name__=='__main__':
    unittest.main(verbosity=2)
