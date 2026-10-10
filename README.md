# zalo-agent

Trợ lý AI cho Zalo, chạy được trên hai kênh sau cùng một giao diện:

| Kênh | Cách kết nối | Ghi chú |
|---|---|---|
| `bot` | [Zalo Bot Platform](https://bot.zaloplatforms.com) (API chính thức, long polling) | An toàn, chỉ gửi văn bản |
| `personal` | Tài khoản cá nhân qua [`zca-js`](https://github.com/RFS-ADRENO/zca-js) (không chính thức) | Có rủi ro bị khoá nick, nên dùng nick phụ |

## Yêu cầu

- Node.js 22 trở lên

## Cài đặt và chạy

```bash
npm install
cp .env.example .env   # rồi điền giá trị
npm start
```

Bật kênh nào thì kênh đó chạy; một kênh lỗi không làm dừng kênh còn lại.

Với kênh `personal`, lần chạy đầu sẽ tạo `data/zalo-qr.png`: mở file và quét bằng app Zalo. Phiên đăng nhập được lưu ở `data/zalo-personal-session.json` (coi như mật khẩu, không chia sẻ).

## Lệnh

| Lệnh | Tác dụng |
|---|---|
| `npm start` | Chạy bot |
| `npm run dev` | Chạy và tự khởi động lại khi sửa mã |
| `npm run typecheck` | Kiểm tra kiểu TypeScript |

## Cấu trúc

```
src/
  index.ts            Điểm khởi động, nối kênh với phần trả lời
  channels/
    types.ts          Giao diện chung ZaloChannel / IncomingMessage
    bot.ts            Kênh Zalo Bot Platform
    personal.ts       Kênh tài khoản cá nhân (zca-js)
    hub.ts            Gom các kênh, trả lời đúng kênh và đúng hội thoại
    text.ts           Cắt tin nhắn dài
```

## Lưu ý vận hành

- Trong nhóm, bot chỉ trả lời khi được @mention.
- Kênh `personal` gửi tin lần lượt, có độ trễ ngẫu nhiên để tránh hành vi giống máy.
- Mỗi tài khoản cá nhân chỉ có một phiên Zalo Web được nghe tin; mở Zalo Web ở nơi khác sẽ ngắt bot.
- Không commit `.env` và thư mục `data/`.
