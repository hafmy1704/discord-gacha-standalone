# Đối chiếu Discord Onboarding và Gacha

- Ngày kiểm tra: 04/09/2026
- Dự án kiểm tra: `C:\Users\thanh\OneDrive\Desktop\discord-gacha-standalone`
- Tài liệu đối chiếu thực tế: `C:\Users\thanh\OneDrive\Desktop\New folder (2)\discord-dau-la-v2\docs\PLAN_DISCORD_GACHA_ONBOARDING.md`
- Lưu ý: đường dẫn tài liệu ban đầu có dấu gạch dưới không tồn tại; file thực tế nằm tại đường dẫn trên.

## Kết luận

Đã triển khai gacha Hồn Khí server-authoritative trong migration `002_hon_khi_gacha.sql`. Các ghi chú thiếu bên dưới là hạng mục onboarding/leaderboard ngoài plan hiện tại.

## Đã có

- `guildMemberAdd` tạo player, gán role `Tân Sinh`.
- Nút `Thức Tỉnh`.
- Thưởng thức tỉnh đúng `10 Hồn Lệnh`, chống cộng lại bằng trạng thái DB.
- Resolve role theo tên, không hardcode role ID.
- Đồng bộ role tu vi cơ bản.
- Chat reward có cooldown, message dedup, fingerprint; không còn giới hạn Hồn Lệnh/ngày.
- Gacha Hồn Khí T1–T10 roll server, kiểm tra số dư, không cho số dư âm.
- Draw/upgrade retry theo `request_id`.
- Launch token HMAC, thời hạn `15 phút`.
- RLS Supabase service-role-only.
- UI responsive, `100dvh`, reduced motion và mobile layout.

## Thiếu lớn

- Chưa có `/whitelist list|add|remove`.
- `.env` hiện có `CHAT_REWARD_CHANNEL_IDS` rỗng; chat reward chưa hoạt động trên channel nào.
- Welcome chưa đủ nội dung game, nội quy, Hồn Khí và link Activity theo plan.
- Chưa có `request_ledger`.
- Thức tỉnh chưa có `requestId` riêng.
- Discord lỗi sau backend commit chưa có retry role sync.
- Chưa có leaderboard Discord/Activity và cache 60 giây.
- API Hồn Khí hiện có `/api/gacha/session`, `/api/gacha/items`, `/api/gacha/draw`, `/api/vault/upgrade`.
- Database có catalog T1–T10, 12 slot trang bị, lịch sử roll, vault upgrade và ledger Tinh Thiết.
- RNG, tier, Niên Hạn, stat, Power và auto-equip chạy ở backend.
- Không có inventory/pending thao tác tay; món yếu/bằng Power tự phân giải.

## Đã xử lý trong plan Hồn Khí

- Chat reward giữ `12–20 Điểm Tu Vi`, cooldown và chống trùng nội dung.
- Bỏ daily cap Hồn Lệnh; ledger không sinh delta `0`.
- Auto-equip dùng điều kiện nghiêm ngặt `newPower > equippedPower`.

## Đánh giá theo nhóm

| Nhóm | Trạng thái | Ghi chú |
|---|---|---|
| Onboarding cơ bản | Một phần | Có member enroll, role và Thức Tỉnh |
| Chat reward | Một phần | Có logic nền nhưng whitelist rỗng, công thức sai spec |
| Gacha sự kiện | Tắt | Bảng lịch sử giữ lại để đối soát |
| Gacha Hồn Khí production | Đã có | T1–T10, server RNG, stat, auto-equip, salvage, vault |
| Leaderboard | Chưa có | Chưa có DB/API/UI |
| Mobile Activity | Một phần | Có responsive CSS, thiếu flow production |
| Observability/recovery | Chưa đủ | Thiếu event log và retry role sync |

## Ưu tiên triển khai

1. Chạy `002_hon_khi_gacha.sql` sau migration nền.
2. Build frontend bằng `npm run gacha:build`.
3. Bổ sung leaderboard/onboarding nâng cao ở phase sau nếu cần.

## File implementation liên quan

- `C:\Users\thanh\OneDrive\Desktop\discord-gacha-standalone\apps\bot\src\index.js`
- `C:\Users\thanh\OneDrive\Desktop\discord-gacha-standalone\apps\bot\src\database.js`
- `C:\Users\thanh\OneDrive\Desktop\discord-gacha-standalone\apps\bot\src\server.js`
- `C:\Users\thanh\OneDrive\Desktop\discord-gacha-standalone\apps\gacha\src\App.tsx`
- `C:\Users\thanh\OneDrive\Desktop\discord-gacha-standalone\supabase\migrations\001_gacha_schema.sql`
