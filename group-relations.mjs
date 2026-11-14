const nativeAffiliations = new Set(["Own", "Hostile", "Neutral", "Indifferent"]);

// Faction describes population/type, not diplomacy. Legacy hostile_to_player
// also requires visibility and attack conditions, so false is not neutrality.
export function groupRelation(group) {
  const affiliation = group?.affiliation_to_player;
  if (nativeAffiliations.has(affiliation)) return {
    affiliation, hostile: affiliation === "Hostile", own: affiliation === "Own",
    nonHostileCandidate: affiliation === "Neutral" || affiliation === "Indifferent", source: "native_affiliation",
  };
  if (group?.faction === "Player") return { affiliation: "Own", hostile: false, own: true, nonHostileCandidate: false, source: "player_faction" };
  if (affiliation != null) return { affiliation: null, hostile: null, own: false, nonHostileCandidate: false, source: "unrecognized_affiliation" };
  if (group?.hostile_to_player === true) return { affiliation: null, hostile: true, own: false, nonHostileCandidate: false, source: "legacy_positive_hostile_flag" };
  const observedNonHostile = group?.visible === true && group?.hostile_to_player === false;
  return { affiliation: null, hostile: null, own: false, nonHostileCandidate: observedNonHostile,
    source: observedNonHostile ? "legacy_visible_unclassified" : "unknown" };
}

export function isHostile(group) {
  return groupRelation(group).hostile === true;
}

export function relationshipCoverage(groups = []) {
  const relations = (groups ?? []).map(groupRelation);
  return {
    scanned_groups: relations.length,
    unknown_relationships: relations.filter(relation => relation.hostile == null).length,
    native_relationships: relations.filter(relation => relation.source === "native_affiliation").length,
    note: "Coverage is for all scanned groups before spatial filters. Unknown relationships are not classified as enemies. Upgrade the plugin for hidden-group affiliations.",
  };
}
