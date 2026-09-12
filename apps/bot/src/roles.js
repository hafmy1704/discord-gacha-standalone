const CULTIVATION_ROLE_NAMES = [
  "Hồn Sĩ",
  "Hồn Sư",
  "Đại Hồn Sư",
  "Hồn Tôn",
  "Hồn Tông",
  "Hồn Vương",
  "Hồn Đế",
  "Hồn Thánh",
  "Hồn Đấu La",
  "Phong Hào Đấu La",
  "Hóa Thần",
];

export const BEGINNER_ROLE_NAME = "Tân Sinh";

export function cultivationRoleName(level) {
  if (!Number.isInteger(level) || level < 0)
    throw new RangeError("invalid cultivation level");
  if (level === 0) return BEGINNER_ROLE_NAME;
  if (level >= 100) return "Hóa Thần";
  if (level >= 90) return "Phong Hào Đấu La";
  return CULTIVATION_ROLE_NAMES[Math.min(8, Math.floor(level / 10))];
}

export function cultivationRoleNames() {
  return [...CULTIVATION_ROLE_NAMES];
}
