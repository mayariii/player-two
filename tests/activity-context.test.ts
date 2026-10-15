import test from 'node:test';
import assert from 'node:assert/strict';
import { activityContext } from '../src/lib/activity-context';
import type { Activity } from '../src/lib/mission';
const activity = (actions: any[]): Activity => ({id:'1',type:'commandExecution',title:'command',time:0,status:'completed',output:'',details:{commandActions:actions,exitCode:0}});
test('describes every structured action rather than only the first', () => {
  const context = activityContext(activity([{type:'search',query:'home',path:'app.css'},{type:'read',path:'src/routes/+page.svelte'}]));
  assert.equal(context.title,'Searched code · Read files');
  assert.match(context.detail,/home.*app.css.*page.svelte/);
});
test('checks and builds describe execution without claiming correctness', () => {
  assert.equal(activityContext(activity([{type:'unknown',command:'npm run test'}])).title,'Ran checks');
  assert.equal(activityContext(activity([{type:'unknown',command:'npm run build'}])).title,'Ran project build');
});
test('script contents cannot be mistaken for observed checks', () => {
  assert.equal(activityContext(activity([{type:'unknown',command:"python3 - <<'PY'\nprint('npm test')\nPY"}])).title,'Ran a script');
});
