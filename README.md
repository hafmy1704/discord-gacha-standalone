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
│       ├── 018_rebuild_clean_schema.sql          # Safe bootstrap schema
│       ├── 019_server_authoritative_rpc_payload.sql
│       └── 020_idempotent_draw_serialization.sql
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
  refinement_steel  bigint      not null default 0 check (refinement_steel >= 0),
  created_at        timestamptz not null default now(),
  primary key (guild_id, user_id)
);
```

- `is_awakened`: đã thức tỉnh hay chưa.
- `cultivation_xp`: tổng Điểm Tu Vi; cấp và điểm dư tự suy ra.
- `soul_orders`: số Hồn Lệnh hiện có.
- `vault_xp`: tổng Tinh Thiết tích lũy; cấp Bảo Khố tự suy ra.
- `refinement_steel`: Tinh Thiết hiện có để tiêu; không dùng để suy ra cấp.
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
CHAT_REWARD_CHANNEL_IDS=ID1,ID2,ID3
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=service_role_key
MINIAPP_SIGNING_SECRET=minimum_32_ky_tu_ngau_nhien
VITE_DISCORD_APPLICATION_ID=Application_ID  # Cho frontend
HOST=127.0.0.1
PORT=6969
# Comma-separated exact frontend origins for dev/proxy deployments.
MINIAPP_ALLOWED_ORIGINS=http://localhost:5173
# Comma-separated Vite hostnames; leave empty for local-only dev.
VITE_ALLOWED_HOSTS=
VITE_BACKEND_HOST=127.0.0.1
```

### 3. Chạy migration Supabase

Vào Supabase Dashboard → SQL Editor, chạy theo thứ tự:

```
supabase/migrations/018_rebuild_clean_schema.sql
supabase/migrations/019_server_authoritative_rpc_payload.sql
supabase/migrations/020_idempotent_draw_serialization.sql
```

`018_rebuild_clean_schema.sql` không còn `DROP ... CASCADE`. Migration tự dừng nếu phát hiện bảng đích đã có dữ liệu; production cần backup và migration additive được owner duyệt trước khi chạy. Không chạy SQL migration production trực tiếp từ bot.

Sau migration, khởi động bot để seed 120 item catalog từ `equipment_t1_t10_manifest.json`. Migration `020` serialize cùng `requestId`, nên retry sau khi mất response không tiêu hao lần hai.

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

| Lệnh | Quyền | Mô tả |
|------|-------|-------|
| `/profile` | Mọi người | Xem Cấp Tu Vi, Hồn Lệnh và trang bị |
| `/hon-lenh nguoi-choi so-luong` | Admin | Cộng Hồn Lệnh cho người chơi |
| `/gacha` | Mọi người (đã thức tỉnh) | Mở Activity gacha |
| `/whitelist` | Admin | Mở bảng bật/tắt kênh thưởng chat |

## Luật kinh tế

- Chat hợp lệ → **12–20 Điểm Tu Vi** + **1 Hồn Lệnh** (cooldown 60 giây, không giới hạn ngày)
- Thức Tỉnh → nhận **10 Hồn Lệnh** lễ vật
- Admin `/hon-lenh` → cộng tùy ý (idempotent theo interaction ID)
- **1 Hồn Lệnh = 1 lượt Triệu Dẫn x1**
- Niên Hạn T1 **50–100**, mỗi tier sau gấp đôi; phân giải trả đúng Niên Hạn Tinh Thiết
- Cấp Bảo Khố 1 bắt đầu từ 100 Tinh Thiết; chi phí cấp kế tiếp tăng **×2**
- Hồn Khí chỉ tự thay khi **Power mới lớn hơn Power hiện tại**; bằng nhau tự phân giải
- Không số dư âm; mọi hoạt động ghi vào `user_activity_log` trong một tháng

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
4. **OAuth2** → Redirects: thêm `https://127.0.0.1`

Chạy local qua tunnel: `cloudflared tunnel --url http://127.0.0.1:6969 --no-autoupdate`. Quick Tunnel chỉ dùng dev/test; production cần named tunnel + stable hostname. Không đưa URL tunnel cũ vào `vite.config.ts`; đặt `VITE_ALLOWED_HOSTS` trong env.

## Role Discord cần tạo trước

Bot sẽ tự gán các role này khi người chơi tăng Cấp Tu Vi:

```
Tân Sinh, Hồn Sĩ, Hồn Sư, Đại Hồn Sư, Hồn Tôn,
Hồn Tông, Hồn Vương, Hồn Đế, Hồn Thánh, Hồn Đấu La,
Phong Hào Đấu La, Hóa Thần
```

Bot cần quyền **Manage Roles** và các role trên phải thấp hơn role của bot. Bật privileged intents **Server Members Intent** và **Message Content Intent** trong Discord Developer Portal; code dùng `GuildMembers` và `MessageContent`.
