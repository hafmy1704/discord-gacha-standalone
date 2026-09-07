import assert from "node:assert/strict";
import test from "node:test";
import { cultivationRoleName } from "./roles.js";

test("cultivation roles use the corrected level bands", () => {
  const cases = [
    [1, "Hồn Sĩ"],
    [9, "Hồn Sĩ"],
    [10, "Hồn Sư"],
    [19, "Hồn Sư"],
    [20, "Đại Hồn Sư"],
    [29, "Đại Hồn Sư"],
    [30, "Hồn Tôn"],
    [39, "Hồn Tôn"],
    [40, "Hồn Tông"],
    [49, "Hồn Tông"],
    [50, "Hồn Vương"],
    [59, "Hồn Vương"],
    [60, "Hồn Đế"],
    [69, "Hồn Đế"],
    [70, "Hồn Thánh"],
    [79, "Hồn Thánh"],
    [80, "Hồn Đấu La"],
    [89, "Hồn Đấu La"],
    [90, "Phong Hào Đấu La"],
    [99, "Phong Hào Đấu La"],
    [100, "Hóa Thần"],
  ];

  for (const [level, expectedRole] of cases)
    assert.equal(cultivationRoleName(level), expectedRole);
});
