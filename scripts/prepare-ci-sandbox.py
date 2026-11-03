"""Allow isolated Terminal tests on disposable GitHub-hosted Ubuntu runners."""
import os
import pathlib
import subprocess

if os.environ.get('GITHUB_ACTIONS') != 'true' or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted':
    raise SystemExit('This setup is restricted to disposable GitHub-hosted runners')

# Ubuntu mediates unprivileged namespace capabilities through AppArmor. This is
# an ephemeral runner setting; production setup and sandbox flags stay intact.
setting = pathlib.Path('/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
if setting.exists() and setting.read_text().strip() != '0':
    subprocess.run(['sudo', 'sysctl', '-w', 'kernel.apparmor_restrict_unprivileged_userns=0'], check=True)

# Fail before building if the runner cannot exercise real network isolation.
subprocess.run(['/usr/bin/bwrap', '--unshare-all', '--die-with-parent',
                '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
                '--cap-drop', 'ALL', '--', '/bin/true'], check=True)
