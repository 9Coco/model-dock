"""Restore a pending desktop proxy transaction after its GUI process exits."""
import argparse
import os
import sys
import time
from pathlib import Path
from system_proxy import DesktopProxyManager


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--watch-fd', type=int, required=True)
    parser.add_argument('--config-dir', type=Path)
    parser.add_argument('--ready-fd', type=int)
    args = parser.parse_args()
    manager = DesktopProxyManager(config_dir=args.config_dir)
    if args.ready_fd is not None:
        os.write(args.ready_fd,b'ready\n')
        os.close(args.ready_fd)
    try:
        # The GUI holds the write end; an orderly exit or crash closes it.
        while os.read(args.watch_fd, 64):
            pass
    except OSError:
        pass
    finally:
        os.close(args.watch_fd)
    # The kernel can deliver pipe EOF while the parent is still exiting.
    for _ in range(30):
        if not manager.journal_path.exists():
            return 0
        try:
            if manager.recover_pending():
                return 0
        except Exception as error:
            print(f'FlowBridge proxy recovery: {error}', file=sys.stderr)
        time.sleep(.2)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
