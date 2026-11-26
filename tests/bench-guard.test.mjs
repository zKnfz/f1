// The benchmark guard must abort on real production trouble, not on scheduled timer runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { unitProblem, parseShow } from '../tools/bench-guard.mjs';

const U = (st, r, pid, t, res = 'success') => ({ LoadState: 'loaded', ActiveState: st, NRestarts: String(r), ExecMainPID: String(pid), ExecMainStartTimestampMonotonic: String(t), Result: res });
const base = {
  'pitwall-relay.service': U('active', 0, 100, 1), 'pitwall-ingest.service': U('active', 0, 200, 2),
  'pitwall-session.service': U('inactive', 0, 0, 5), 'pitwall-maintain.service': U('inactive', 0, 0, 0),
  'pitwall-health.service': { LoadState: 'not-found' },
};
const w = (k, v) => ({ ...base, [k]: v });

test('scheduled runs are not problems', () => {
  assert.equal(unitProblem(base, base), null);
  assert.equal(unitProblem(base, w('pitwall-session.service', U('active', 0, 900, 9))), null);   // timer started it (17:40:01 on Oracle)
  assert.equal(unitProblem(base, w('pitwall-session.service', U('inactive', 0, 0, 9))), null);   // and it finished
  assert.equal(unitProblem(base, w('pitwall-maintain.service', U('activating', 0, 50, 9))), null);
});
test('failures of scheduled units are problems', () => {
  assert.match(unitProblem(base, w('pitwall-session.service', U('failed', 0, 0, 9, 'exit-code'))), /failed/);
  assert.match(unitProblem(base, w('pitwall-session.service', U('activating', 1, 0, 9, 'exit-code'))), /restarted after a failure/);
  assert.match(unitProblem(base, w('pitwall-maintain.service', U('inactive', 0, 0, 9, 'timeout'))), /failed/);
});
test('a failure already present before the benchmark does not abort it', () => {
  const pre = w('pitwall-session.service', U('failed', 0, 0, 5, 'exit-code'));
  assert.equal(unitProblem(pre, pre), null);
});
test('always-on services: any restart, replacement or outage is a problem', () => {
  assert.match(unitProblem(base, w('pitwall-relay.service', U('active', 1, 101, 3))), /restarted/);
  assert.match(unitProblem(base, w('pitwall-relay.service', U('active', 0, 101, 3))), /main process replaced/);
  assert.match(unitProblem(base, w('pitwall-ingest.service', U('activating', 0, 0, 2))), /is activating/);
  assert.match(unitProblem(base, w('pitwall-ingest.service', null)), /unreadable/);
});
test('units not installed are ignored', () => {
  const none = w('pitwall-relay.service', { LoadState: 'not-found' });
  assert.equal(unitProblem(none, w('pitwall-relay.service', { LoadState: 'not-found', ActiveState: 'inactive' })), null);
});
test('systemctl show parsing', () => {
  assert.deepEqual(parseShow('ActiveState=active\nNRestarts=0\nResult=success\nExecMainStartTimestampMonotonic=123\n'), { ActiveState: 'active', NRestarts: '0', Result: 'success', ExecMainStartTimestampMonotonic: '123' });
});
