# Đối chiếu Discord Onboarding và Gacha

- Ngày kiểm tra: 07/09/2026
- Dự án: `discord-gacha-standalone`

## Kết luận

Gacha Hồn Khí chạy server-authoritative. Schema hiện tại nằm ở `018_rebuild_clean_schema.sql`, payload/API ở `019_server_authoritative_rpc_payload.sql`, replay serialization ở `020_idempotent_draw_serialization.sql`.

## Đã có

- `guildMemberAdd` tạo player, gán role `Tân Sinh`.
- Nút `Thức Tỉnh`, chống cộng lại bằng trạng thái DB.
- Đồng bộ role tu vi theo tên role.
- Chat reward có cooldown, message dedup và fingerprint.
- Gacha Hồn Khí T1–T10 roll server, kiểm tra số dư, không cho số dư âm.
- Retry draw giữ nguyên `requestId`; DB khóa transaction để replay không tiêu hao lần hai.
- Launch token HMAC, thời hạn 15 phút.
- RLS Supabase service-role-only.
- API state-changing có Origin/Fetch-Metadata guard và JSON content-type guard.
- `/health` trả `503` trước khi Discord startup/seed hoàn tất.
- Server mặc định bind `127.0.0.1`; tunnel production phải dùng named tunnel + hostname ổn định.

## Owner gates còn lại

- Backup và review schema trước khi chạy migration trên Supabase production. Migration `018` fail-closed nếu bảng đích đã có dữ liệu; không chạy `DROP ... CASCADE`.
- Tạo đủ role Discord, bật `Server Members Intent` và `Message Content Intent`.
- Cấu hình `MINIAPP_ALLOWED_ORIGINS` khi frontend chạy khác origin backend.
- Không dùng Quick Tunnel cho production.

## Verification

- `npm run gacha:test`: 13/13 pass.
- `npm run gacha:typecheck`: pass.
- `npm run gacha:build`: pass; còn cảnh báo chunk Phaser lớn.
- `npm audit --omit=dev`: 0 vulnerabilities.

## File implementation

- `apps/bot/src/index.js`
- `apps/bot/src/database.js`
- `apps/bot/src/server.js`
- `apps/bot/src/database.test.js`
- `apps/bot/src/server.security.test.js`
- `apps/gacha/src/App.tsx`
- `apps/gacha/vite.config.ts`
- `supabase/migrations/018_rebuild_clean_schema.sql`
- `supabase/migrations/019_server_authoritative_rpc_payload.sql`
- `supabase/migrations/020_idempotent_draw_serialization.sql`
