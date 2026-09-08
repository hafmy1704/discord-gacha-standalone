# Discord Gacha Standalone

Bot Discord + Miniapp Gacha Hồn Khí T1–T10 tích hợp Supabase. Hoàn toàn độc lập, không phụ thuộc vào dự án Discord Đấu La chính.

## Tổng quan

```
Chat → Điểm Tu Vi + Hồn Lệnh → Triệu Dẫn Hồn Khí → Tự trang bị / phân giải → Nâng Bảo Khố
```

- **Bot Discord** (`apps/bot`) — Xử lý lệnh slash, chat reward, role Tu Vi, nút Thức Tỉnh
- **Miniapp Frontend** (`apps/gacha`) — UI gacha React/Vite/TypeScript với hiệu ứng Phaser WebGL
- **Supabase Backend** — Toàn bộ logic atomic trong stored procedures; RLS service-role-only

## Cấu trúc

```
discord-gacha-standalone/
├── .env.example
├── supabase/
│   └── migrations/
│       └── 001_initial_schema.sql                # Canonical create-only schema
├── apps/
│   ├── bot/                        # Discord bot + HTTP server
│   │   └── src/
│   │       ├── index.js            # Entry point
│   │       ├── database.js         # Supabase REST adapter
│   │       ├── server.js           # HTTP miniapp server
│   │       ├── launch-token.js     # HMAC auth token
│   │       ├── content.js          # Chat content validation
│   │       ├── roles.js            # Discord cultivation roles
│   │       └── hon-khi.js          # Công thức + catalog server-side
│   └── gacha/                      # React frontend (Discord Activity)
│       └── src/
│           ├── App.tsx             # UI chính
│           ├── GachaVfx.tsx        # Hiệu ứng Phaser
│           └── styles.css
```

## Schema cuối `public.players`

`players` chỉ giữ trạng thái hiện tại. Hoạt động người dùng nằm ở `user_activity_log` và giữ một tháng.

```sql
create table public.players (
  guild_id          text        not null,
  user_id           text        not null,
  is_awakened       boolean     not null default false,
  cultivation_xp    bigint      not null default 0 check (cultivation_xp >= 0),
  soul_orders       bigint      not null default 0 check (soul_orders >= 0),
  vault_xp          bigint      not null default 0 check (vault_xp >= 0),
  created_at        timestamptz not null default now(),
  primary key (guild_id, user_id)
);
```

- `is_awakened`: đã thức tỉnh hay chưa.
- `cultivation_xp`: tổng Điểm Tu Vi; cấp và điểm dư tự suy ra.
- `soul_orders`: số Hồn Lệnh hiện có.
- `vault_xp`: tổng Hồn Thiết tích lũy; cấp và tiến độ Bảo Khố tự suy ra.
- `created_at`: thời điểm ghi danh đầu tiên.

Cấp Bảo Khố dùng tổng chi phí lũy kế:

```text
cost(level) = 100 × 2^(level - 1)
vault_xp(level L) = 100 × (2^(L - 1) - 1)
```

## Schema cuối `public.guild_config`

`guild_config` chỉ giữ cấu hình đang dùng; không lưu timestamp cập nhật.

```sql
create table public.guild_config (
  guild_id           text   primary key,
  channel_ids        text[] not null default '{}',
  welcome_message_id text
);
```

## Schema cuối `public.hon_khi_catalog`

`slot_label` suy ra từ `slot`; mỗi `tier + slot` chỉ có một item catalog.

```sql
create table public.hon_khi_catalog (
  item_code     text primary key,
  tier          integer not null,
  slot          text not null,
  name          text not null,
  slot_budget   numeric(10, 4) not null,
  asset_key     text
);
```

## Schema cuối Hồn Khí theo user

`hon_khi_equipped` chỉ giữ món mạnh nhất trong từng slot.

```sql
create table public.hon_khi_equipped (
  guild_id    text        not null,
  user_id     text        not null,
  slot        text        not null,
  item_code   text        not null,
  tier        integer     not null,
  age_years   integer     not null,
  stats       jsonb       not null default '{}',
  power       numeric     not null,
  acquired_at timestamptz not null default now(),
  primary key (guild_id, user_id, slot)
);
```

`user_hon_khi_collection` ghi mỗi item một dòng/user; roll trùng chỉ tăng `roll_count`.

```sql
create table public.user_hon_khi_collection (
  guild_id   text   not null,
  user_id    text   not null,
  item_code  text   not null,
  roll_count bigint not null default 1,
  primary key (guild_id, user_id, item_code)
);
```

`user_activity_log` là log chung, giữ một tháng; mỗi roll chỉ ghi một dòng.

```sql
create table public.user_activity_log (
  id         bigint generated always as identity primary key,
  guild_id   text        not null,
  user_id    text        not null,
  event_type text        not null,
  request_id text,
  payload    jsonb       not null default '{}',
  created_at timestamptz not null default now()
);
```

`request_receipts` giữ biên nhận idempotency độc lập với log hiển thị. Bảng này
không bị tác vụ dọn log một tháng xóa, nên retry cùng `request_id` không thể thực
thi lại một giao dịch đã commit.

```sql
create table public.request_receipts (
  guild_id   text        not null,
  event_type text        not null,
  request_id text        not null,
  user_id    text        not null,
  result     jsonb       not null,
  created_at timestamptz not null default now(),
  primary key (guild_id, event_type, request_id)
);
```

## Cài đặt

### 1. Clone & install

```bash
  git clone https://github.com/hafmy1704/discord-gacha-standalone
cd discord-gacha-standalone
npm install
```

### 2. Tạo file .env

Sao chép `.env.example` thành `.env` và điền đầy đủ:

```env
DISCORD_TOKEN=Bot_Token_Của_Bạn
DISCORD_APPLICATION_ID=Application_ID
DISCORD_GUILD_ID=Guild_ID_Server
DISCORD_CLIENT_SECRET=Client_Secret
WELCOME_CHANNEL_ID=ID_Kênh_Welcome
SOUL_AWAKENING_CHANNEL_ID=ID_Kênh_Thức_Tỉnh
SON_MON_CATEGORY_ID=ID_Category_Sơn_Môn
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service_role_key
MINIAPP_SIGNING_SECRET=minimum_32_ky_tu_ngau_nhien
VITE_DISCORD_APPLICATION_ID=Application_ID  # Cho frontend
HOST=127.0.0.1
PORT=6969
# Comma-separated exact frontend origins for dev/proxy deployments.
MINIAPP_ALLOWED_ORIGINS=https://1544680848937451600.discordsays.com,https://gacha.msvn.io.vn
# Comma-separated Vite hostnames; leave empty for local-only dev.
VITE_ALLOWED_HOSTS=
VITE_BACKEND_HOST=127.0.0.1
```

### 3. Chạy migration Supabase

Vào Supabase Dashboard → SQL Editor, chạy theo thứ tự:

```
supabase/migrations/001_initial_schema.sql
```

`001_initial_schema.sql` là schema canonical đầy đủ: chỉ tạo bảng/function/index/trigger, cấu hình RLS/quyền; không chứa câu lệnh xóa dữ liệu hay migration vá. Chạy trên database mới hoặc schema đã được owner xác nhận tương thích. Không chạy SQL migration production trực tiếp từ bot.

Sau migration, khởi động bot để seed 120 item catalog từ `equipment_t1_t10_manifest.json`. RPC gacha serialize theo `requestId`, nên retry sau khi mất response không tiêu hao lần hai.

Hoặc dùng Supabase CLI:

```bash
supabase db push
```

### 4. Build frontend

```bash
npm run gacha:build
```

### 5. Khởi động bot

```bash
cd apps/bot
npm start
```

Bot sẽ:

- Bind `HOST` (mặc định `127.0.0.1`) và cổng `PORT` (mặc định 3000)
- Phục vụ frontend tại `/` (từ `apps/gacha/dist/`)
- Phục vụ API tại `/api/`
- Trả `503` từ `/health` đến khi Discord và startup seed hoàn tất

---

## Lệnh Discord

| Lệnh                            | Quyền                    | Mô tả                               |
| ------------------------------- | ------------------------ | ----------------------------------- |
| `/profile`                      | Mọi người                | Xem Cấp Tu Vi, Hồn Lệnh và trang bị |
| `/hon-lenh them nguoi-choi so-luong` | Admin                    | Cộng Hồn Lệnh cho người chơi        |
| `/hon-lenh xoa nguoi-choi so-luong` | Admin                    | Trừ Hồn Lệnh, không cho số dư âm     |
| `/gacha`                        | Mọi người (đã thức tỉnh) | Mở Activity gacha                   |
| `/whitelist`                    | Admin                    | Mở bảng bật/tắt kênh thưởng chat    |

## Công thức game

Server/Supabase là nguồn tính duy nhất; frontend chỉ hiển thị kết quả. Với mọi phép random, `U` là số thực đều trong `[0, 1)`.

### 1. Tu vi và role

Với tổng `xp = cultivation_xp`, cấp tu vi là cấp cao nhất thỏa điều kiện:

```text
L = max { L >= 1 | 50 × L × (L - 1) <= xp }
cultivationPoints = xp - 50 × L × (L - 1)
cultivationPointsRequired = 100 × L
cultivationProgress = round(cultivationPoints / (100 × L), 4)
```

|   Cấp | Role             |
| ----: | ---------------- |
|   1–9 | Hồn Sĩ           |
| 10–19 | Hồn Sư           |
| 20–29 | Đại Hồn Sư       |
| 30–39 | Hồn Tôn          |
| 40–49 | Hồn Tông         |
| 50–59 | Hồn Vương        |
| 60–69 | Hồn Đế           |
| 70–79 | Hồn Thánh        |
| 80–89 | Hồn Đấu La       |
| 90–99 | Phong Hào Đấu La |
| >=100 | Hóa Thần         |

### 2. Thưởng chat

Tin nhắn hợp lệ khi không rỗng, không bắt đầu bằng `!` hoặc `/`, sau chuẩn hóa còn ít nhất `8` ký tự chữ/số. Đặt:

```text
U = số ký tự chữ/số khác nhau sau chuẩn hóa
S = số câu, tối thiểu 1
R = 1 nếu reply người thật khác tác giả, ngược lại 0

bonus = min(6, max(0, floor((U - 8) / 4)))
       + (1 nếu S >= 2, ngược lại 0)
       + R
cultivationGain = min(20, 12 + bonus)
soulOrdersGain = 1
```

Chuẩn hóa dùng NFKC, chữ thường tiếng Việt, loại URL/mention/emoji và ký tự không phải chữ, số, khoảng trắng, `.?!`. Mỗi người nhận tối đa một thưởng mỗi `60 giây`. Fingerprint trùng trong `10 phút` với khoảng cách Hamming `<= 4` bị bỏ qua. Message ID đã xử lý cũng idempotent.

### 3. Thức tỉnh và admin grant

```text
awakeningBonus = 10 Hồn Lệnh
newSoulOrders = oldSoulOrders + grantAmount
```

Thức tỉnh chỉ cộng thưởng một lần. `/hon-lenh` nhận `grantAmount` nguyên trong `[1, 1.000.000]`; `sourceId` đã xử lý không cộng lần hai.

### 4. Bảo Khố và Hồn Thiết

```text
upgradeCost(L) = 100 × 2^(L - 1)
requiredVaultXp(L) = 100 × (2^(L - 1) - 1)
vaultLevel(xp) = max { L >= 1 | requiredVaultXp(L) <= xp }
```

Khi phân giải hoặc thay trang bị, `salvageSteel = ageYears` của món bị phân giải. Sau mỗi lượt:

```text
vault_xp = vault_xp + salvageSteel
vaultProgressXp = vault_xp - requiredVaultXp(vaultLevel(vault_xp))
vaultProgress = round(
  min(1, vaultProgressXp / upgradeCost(vaultLevel(vault_xp))) × 100,
  2
)
```

Cấp Bảo Khố không tiêu Hồn Thiết; `vaultLevel`, `vaultProgressXp` và `vaultProgress` đều là giá trị suy ra từ `vault_xp`. Không có số dư Hồn Thiết thứ hai.

### 5. Tỉ lệ tier

Với `V = vaultLevel`:

```text
firstRate = max(0, 0.90 - 0.10 × (V - 1))
maxTier = min(10, max(2, V))
decay = min(0.65, 0.20 + 0.05 × max(0, V - 3))
W = sum(decay^k, k = 0 .. maxTier - 2)

P(T1) = firstRate
P(Tt) = (1 - firstRate) × decay^(t - 2) / W, 2 <= t <= maxTier
P(Tt) = 0, t > maxTier
```

Mỗi `1 Hồn Lệnh` là một lượt x1. Sau khi chọn tier, item được chọn đều trong catalog của tier đó. Gacha có cooldown `4 giây` gồm `3 giây` animation và `1 giây` chờ giữa hai lượt; `requestId` hợp lệ dài `8–128` ký tự (`A-Z`, `a-z`, `0-9`, `_`, `-`) và replay không tiêu hao thêm Hồn Lệnh.

| Tier | Tên        |
| ---: | ---------- |
|   T1 | Phàm Thiết |
|   T2 | Tinh Đồng  |
|   T3 | Thanh Mộc  |
|   T4 | Xích Viêm  |
|   T5 | Hoàng Nham |
|   T6 | Bạch Kim   |
|   T7 | Huyền Thủy |
|   T8 | Tinh Đấu   |
|   T9 | Hải Thần   |
|  T10 | Thần Vực   |

### 6. Niên Hạn và Power

Với tier `T`:

```text
ageMin = 50 × 2^(T - 1)
ageMax = 2 × ageMin
ageYears = ageMin + floor(U × (ageMax - ageMin + 1))
ageFactor = round(0.85 + 0.30 × (ageYears - ageMin) / (ageMax - ageMin), 4)
budget = round(100 × slotBudget × 1.6^(T - 1) × ageFactor, 4)
```

| Slot     | Tên hiển thị | Nhóm stat | `slotBudget` |
| -------- | ------------ | --------- | -----------: |
| weapon   | Vũ Khí       | Attack    |         0.65 |
| offhand  | Phó Khí      | Attack    |         0.40 |
| crown    | Hồn Quan     | HP        |         0.25 |
| armor    | Hộ Giáp      | HP        |         0.65 |
| bracer   | Hộ Uyển      | Attack    |         0.30 |
| belt     | Hồn Đai      | HP        |         0.25 |
| boots    | Linh Ngoa    | Accuracy  |         0.35 |
| necklace | Hồn Liên     | Accuracy  |         0.25 |
| ring     | Hồn Giới     | Attack    |         0.20 |
| talisman | Hộ Phù       | HP        |         0.20 |
| treasure | Bí Bảo       | Accuracy  |         0.30 |
| seal     | Hồn Ấn       | Accuracy  |         0.20 |

Trọng số stat cơ bản:

| Slot                            | Attack |   HP | Accuracy |
| ------------------------------- | -----: | ---: | -------: |
| weapon, offhand, bracer, ring   |   0.50 | 0.25 |     0.25 |
| crown, armor, belt, talisman    |   0.25 | 0.50 |     0.25 |
| boots, necklace, treasure, seal |   0.25 | 0.25 |     0.50 |

```text
attack = round(budget × attackWeight, 2)
hp = round(budget × hpWeight, 2)
accuracy = round(budget × accuracyWeight, 2)
special_i = round((1.5 + 4.5 × U_i) × T, 2), i = 1, 2
power = round(attack + hp + accuracy + 2 × (special_1 + special_2), 2)
```

Mỗi món nhận `2` special stat khác nhau, chọn trong `basicPower`, `skillPower`, `ultimatePower`, `speed`, `critRate`, `critDamage`, `skillHaste`, `evasion`. Chỉ thay món cùng slot khi `newPower > oldPower`; ngược lại món mới phân giải và trả `ageYears` Steel. Tổng sức mạnh:

```text
equipmentPower = sum(power của các slot đang trang bị)
combatPower = 100 × cultivationLevel + equipmentPower
```

Collection tăng `roll_count` sau mỗi lượt, kể cả món được trang bị hay phân giải. Catalog chuẩn có `10 × 12 = 120` item.

### 7. Tóm tắt giới hạn

- Chat hợp lệ: `12–20` Điểm Tu Vi + `1` Hồn Lệnh.
- Thức tỉnh: `10` Hồn Lệnh một lần.
- Admin grant: `1–1.000.000` Hồn Lệnh mỗi source ID.
- `vault_xp` và Hồn Lệnh không âm; mọi thay đổi ghi vào `user_activity_log` và log cũ hơn một tháng được dọn.

## Acceptance criteria

- Retry roll cùng `requestId` không trừ Hồn Lệnh lần hai
- Catalog trống → trả lỗi `gacha_empty`
- Số dư Hồn Lệnh và Tinh Thiết không âm; mỗi lượt có một dòng `user_activity_log`
- Collection tăng `roll_count`; equipped chỉ giữ món mạnh nhất mỗi slot
- Token miniapp hết hạn sau 15 phút; backend kiểm tra trước mọi request

## Discord Developer Portal

Để `/gacha` mở Activity:

1. Vào [Discord Developer Portal](https://discord.com/developers/applications) → Application của bạn
2. **Activities** → **Settings** → **Supported Platforms** → bật **Web**
3. **Activities** → **URL Mappings**: prefix `/`, target `domain-của-bạn` (không nhập `https://`)
4. **OAuth2** → Redirects: cấu hình theo môi trường Discord yêu cầu.

Production dùng Named Cloudflare Tunnel:

```powershell
cloudflared tunnel run --token <TUNNEL_TOKEN>
```

Route: `gacha.msvn.io.vn` → `http://127.0.0.1:6969`.

## Role Discord cần tạo trước

Bot sẽ tự gán các role này khi người chơi tăng Cấp Tu Vi:

```
Tân Sinh, Hồn Sĩ, Hồn Sư, Đại Hồn Sư, Hồn Tôn,
Hồn Tông, Hồn Vương, Hồn Đế, Hồn Thánh, Hồn Đấu La,
Phong Hào Đấu La, Hóa Thần
```

Bot cần quyền **Manage Roles** và các role trên phải thấp hơn role của bot. Bật privileged intents **Server Members Intent** và **Message Content Intent** trong Discord Developer Portal; code dùng `GuildMembers` và `MessageContent`.
