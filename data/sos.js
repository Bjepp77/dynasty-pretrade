// DEMO ESTIMATE ONLY. Not live data. Hand-set "remaining strength of schedule" rank for 2026.
// 1 = easiest remaining schedule for offensive players, 32 = hardest.
var SOS_RANK = {
  ARI:9, ATL:14, BAL:27, BUF:20, CAR:6, CHI:18, CIN:12, CLE:30, DAL:4, DEN:25, DET:16, GB:22,
  HOU:24, IND:8, JAX:11, KC:28, LV:29, LAC:21, LAR:26, MIA:3, MIN:19, NE:10, NO:2, NYG:17,
  NYJ:5, PHI:23, PIT:31, SF:32, SEA:15, TB:7, TEN:1, WAS:13
};
if (typeof module !== "undefined") module.exports = SOS_RANK;
