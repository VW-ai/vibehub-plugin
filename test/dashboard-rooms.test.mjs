import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const sandbox = {};
vm.runInNewContext(readFileSync(new URL('../skills/vibehub-review/assets/dashboard-rooms.js', import.meta.url), 'utf8'), sandbox);
const { hierarchy, matchingRooms } = sandbox.VibeHubRooms;
const room = (workspace, name, parent = null) => ({ key: `${workspace}:${name}`, workspace, room: name, parent });

test('Room branches follow actual ancestry and never cross workspaces with identical names', () => {
  const rooms = [room('a', 'root/api', 'root'), room('b', 'root'), room('a', 'root'), room('a', 'root/api/v1', 'root/api'), room('b', 'root/api', 'root')];
  const tree = hierarchy(rooms);
  assert.deepEqual(Array.from(tree, item => [item.key, item.parentKey, item.depth]), [
    ['b:root', null, 0], ['b:root/api', 'b:root', 1],
    ['a:root', null, 0], ['a:root/api', 'a:root', 1], ['a:root/api/v1', 'a:root/api', 2],
  ]);
  assert.equal(rooms[0].depth, undefined, 'presentation must not mutate stored Room data');
});

test('search retains all matching Room ancestors without including unrelated workspaces', () => {
  const rooms = [room('a', 'root'), room('a', 'root/api', 'root'), room('a', 'root/api/v1', 'root/api'), room('b', 'root'), room('a', 'other')];
  assert.deepEqual(Array.from(matchingRooms(rooms, ['a:root/api/v1']), item => item.key), ['a:root', 'a:root/api', 'a:root/api/v1']);
  assert.equal(matchingRooms(rooms, []).length, 0);
  assert.equal(hierarchy([room('a', 'orphan', 'missing')])[0].parentKey, null);
});

test('Context type groups keep active records first within their own type and omit empty groups', () => {
  const records = [
    {type:'note',state:'active',summary:'One note'},
    {type:'decision',state:'superseded',summary:'Earlier decision'},
    {type:'constraint',state:'active',summary:'A limit'},
    {type:'decision',state:'active',summary:'Current decision'},
  ];
  const grouped = sandbox.VibeHubRooms.groupByType(records);
  assert.deepEqual(Array.from(grouped, group => group.type), ['decision','constraint','note']);
  assert.deepEqual(Array.from(grouped[0].records, record => record.summary), ['Current decision','Earlier decision']);
  assert.equal(records[0].type, 'note', 'grouping does not mutate the source array');
  assert.equal(sandbox.VibeHubRooms.groupByType([]).length, 0);
});
