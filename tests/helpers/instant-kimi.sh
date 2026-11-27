#!/bin/sh
# A stand-in for `kimi -p` that finishes within a few milliseconds, so a launcher
# can lose the race to read its process identity. `--version` prints 2.8.0.
#   INSTANT_KIMI_EXIT_CODE  (default 0) fail at once with this code instead of answering.
#   INSTANT_KIMI_DELAY      seconds to stay alive before doing anything else.
#   INSTANT_KIMI_WRITE      a path, relative to the working directory, to create before answering.
#   INSTANT_KIMI_HELPER     leave a `sleep` behind that outlives this process:
#                             ingroup  - in this process group, holding none of its pipes
#                             detached - in its own session and process group, holding stdout and stderr
#   INSTANT_KIMI_HELPER_SECONDS  how long that helper lives (default 4), so a leak clears itself.
#   INSTANT_KIMI_HELPER_PID      a file that receives the helper's PID.
if [ "${1:-}" = "--version" ]; then
  echo "2.8.0"
  exit 0
fi
if [ -n "${INSTANT_KIMI_DELAY:-}" ]; then
  sleep "$INSTANT_KIMI_DELAY"
fi
code="${INSTANT_KIMI_EXIT_CODE:-0}"
if [ "$code" != "0" ]; then
  echo "instant-kimi: forced startup failure" >&2
  exit "$code"
fi
if [ -n "${INSTANT_KIMI_WRITE:-}" ]; then
  echo "written by the stand-in" > "$INSTANT_KIMI_WRITE"
fi
case "${INSTANT_KIMI_HELPER:-}" in
  ingroup)
    sleep "${INSTANT_KIMI_HELPER_SECONDS:-4}" > /dev/null 2>&1 &
    if [ -n "${INSTANT_KIMI_HELPER_PID:-}" ]; then echo "$!" > "$INSTANT_KIMI_HELPER_PID"; fi
    ;;
  detached)
    # Shell job control does not move a background job to a new group without a
    # terminal. The fork is orphaned within microseconds, so a process listing
    # rarely shows it as this process's descendant.
    perl -MPOSIX -e '
      my ($seconds, $pidfile) = @ARGV;
      my $pid = fork();
      die "fork failed" unless defined $pid;
      if ($pid) {
        if ($pidfile) { open(my $fh, ">", $pidfile) or die "pid file"; print $fh $pid; close $fh; }
        exit 0;
      }
      setsid();
      exec "sleep", $seconds;
    ' "${INSTANT_KIMI_HELPER_SECONDS:-4}" "${INSTANT_KIMI_HELPER_PID:-}"
    ;;
esac
session="session_00000000-0000-4000-8000-0000000000aa"
printf '%s\n' \
  '{"role":"meta","type":"system.version","version":"2.8.0"}' \
  '{"role":"assistant","content":"Instant answer from the stand-in."}' \
  "{\"role\":\"meta\",\"type\":\"session.resume_hint\",\"session_id\":\"$session\",\"command\":\"kimi -r $session\",\"content\":\"To resume this session: kimi -r $session\"}"
exit 0
