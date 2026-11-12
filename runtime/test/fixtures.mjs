// Deterministic world fixture used by runtime tests (shape mirrors plugin/WorldData.cs).
export const TEST_SESSION = "session-test-1";
export const TEST_HQ = { x: 1331.2, y: 25.1, z: 1478.3 };

const character = (memberId, groupId, x, z, hp = 100) => ({
  id: String(memberId), name: "队员" + memberId, type: "Human", child: false, group_id: groupId,
  position: { x, y: 25, z }, hp, max_hp: 100, job: null, weapon_id: "eq_pistol", ammo: 1,
});

const squad = (id, name, x, z, { members = 4, activeOrder = null, hp = 100, vehicleId = null } = {}) => ({
  id: String(id), name, type: "player", faction: "Player",
  position: { x, y: 25, z }, destination: { x, y: 25, z },
  vehicle_id: vehicleId, waiting_vehicle_id: null,
  active_order: activeOrder, queued_orders: [],
  visible: true, hostile_to_player: false,
  weapon_id: "eq_pistol", cargo: {},
  member_count: members,
  members: Array.from({ length: members }, (_, i) => character(600 + i, String(id), x + i, z, hp)),
});

const enemyGroup = (id, type, x, z, members, { visible = true, hostile = true } = {}) => ({
  id: String(id), name: "敌群" + id, type, faction: "Infected",
  position: { x, y: 25, z }, destination: null,
  vehicle_id: null, waiting_vehicle_id: null,
  active_order: null, queued_orders: [],
  visible, hostile_to_player: hostile,
  weapon_id: null, cargo: {},
  member_count: members,
  members: Array.from({ length: Math.min(members, 32) }, (_, i) => character(900 + i, String(id), x + i, z)),
});

export function createWorld({ sessionId = TEST_SESSION, buildingCount = 250 } = {}) {
  const squads = [
    squad("834", "玩家", 1279, 1466),
    squad("835", "小队 2", 1320, 1474, { activeOrder: "MoveToBuildingOrder" }),
    squad("836", "小队 3", 1362, 1333),
  ];
  const groups = [
    // groups category also contains player squads (hostile_to_player=false)
    ...squads.map((row) => ({ ...row, members: row.members })),
    enemyGroup("g1", "inf_human", 1600, 1478, 8),
    enemyGroup("g2", "hideout_infected_inf_human", 1900, 1200, 100),
    enemyGroup("g3", "inf_human", 1500, 1478, 6, { visible: false, hostile: false }),
  ];
  const vehicles = [{
    id: "781", type: "ve_combi", owner_group_id: "835", has_driver: true,
    position: { x: 1320, y: 25, z: 1474 }, destination: null,
    fuel: { ratio: 0.9, capacity: 40 },
    trunk: { occupied_slots: 7, capacity_slots: 15, load_ratio: 0.47, available_slots: 8, cargo: { res_cans: 3 } },
  }];
  const stockpile = [
    { storage: "physical", resource_id: "res_cans", quantity: 120, available: 110 },
    { storage: "physical", resource_id: "res_ammo", quantity: 45, available: 40 },
    { storage: "physical", resource_id: "res_fuel", quantity: 6, available: 6 },
    { storage: "physical", resource_id: "res_wood", quantity: 30, available: 30 },
  ];
  const events = [
    { kind: "mission", id: "mission_a", title_key: "mission_a_title",
      objectives: [{ id: "obj_1", type: "AdaptBuilding", completed: false }, { id: "obj_2", type: "CompleteResearch", completed: true }],
      markers: [{ x: 1340, y: 25, z: 1350 }] },
    { kind: "event", id: "event_bandit_plot" },
  ];
  const stockrooms = [{ id: "417900040", headquarters: true, position: { ...TEST_HQ } }];
  const buildings = Array.from({ length: buildingCount }, (_, i) => ({
    id: String(417900000 + i), osm_id: String(100000 + i),
    position: { x: 900 + (i % 50) * 10, y: 25, z: 1200 + Math.floor(i / 50) * 10 },
    bounds: { min_x: 900 + (i % 50) * 10, min_z: 1200 + Math.floor(i / 50) * 10, max_x: 908 + (i % 50) * 10, max_z: 1208 + Math.floor(i / 50) * 10 },
    completed: true,
    can_scavenge: i % 3 !== 0,
    scavenged: i % 5 === 0,
    stockroom: i === 0,
  }));
  const state = {
    ready: true, session_id: sessionId, focused: true,
    time: { day: 6, hour: 18.2, sunset: 17.7, elapsed_game_seconds: 20, paused: false, gameplay_pause: false, popup_pause: false, ui_pause: false },
    headquarters: { ...TEST_HQ }, headquarters_id: "417900040",
    squads: squads.map((row) => ({
      id: row.id, name: row.name, position: row.position, moving: false,
      in_vehicle: Boolean(row.vehicle_id), vehicle_id: row.vehicle_id, idle: !row.active_order,
    })),
    advance: null,
  };
  return { state, world: { squads, vehicles, groups, virtualGroups: [], stockpile, events, stockrooms, buildings } };
}
