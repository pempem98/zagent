# zalo-agent

Trợ lý AI tư vấn trên Zalo: trả lời theo tài liệu có sẵn, tra cứu thêm bằng công cụ, và chuyển câu hỏi cho người thật khi cần.

Chạy được trên hai kênh sau cùng một giao diện:

| Kênh | Cách kết nối | Ghi chú |
|---|---|---|
| `bot` | [Zalo Bot Platform](https://bot.zaloplatforms.com) (API chính thức, long polling) | An toàn, chỉ gửi văn bản |
| `personal` | Tài khoản cá nhân qua [`zca-js`](https://github.com/RFS-ADRENO/zca-js) (không chính thức) | Có rủi ro bị khoá nick, nên dùng nick phụ |

## Yêu cầu

- Node.js 22 trở lên, hoặc Docker (xem "Chạy bằng Docker")
- Khoá API của ít nhất một nhà cung cấp model (Gemini, OpenAI, DeepSeek, Qwen...), hoặc Ollama chạy trên máy

## Cài đặt và chạy

```bash
npm install
cp .env.example .env   # rồi điền giá trị
npm start
```

Bật kênh nào thì kênh đó chạy; một kênh lỗi không làm dừng kênh còn lại.

Với kênh `personal`, lần chạy đầu sẽ tạo `data/zalo-qr.png`: mở file và quét bằng app Zalo. Phiên đăng nhập được lưu ở `data/zalo-personal-session.json` (coi như mật khẩu, không chia sẻ).

## Chạy bằng Docker

```bash
cp .env.example .env                  # rồi điền giá trị
cp mcp.example.json mcp.json          # sửa hoặc để nguyên
cp tools.example.json tools.json      # hoặc tạo file chỉ chứa: { "tools": [] }
docker compose up -d --build
docker compose logs -f                # xem log; Ctrl+C để thôi xem
```

Image chỉ chứa mã nguồn và thư viện. Mọi thứ của bạn nằm ngoài container và được gắn vào khi chạy, nên cập nhật hay dựng lại image không làm mất gì:

| Trên máy | Gắn vào container | Nội dung |
|---|---|---|
| `.env`, `mcp.json`, `tools.json` | Chỉ đọc | Cấu hình |
| `workspace/` | Đọc và ghi | Hướng dẫn hệ thống, quy trình, tài liệu, bảng hàng |
| `data/` | Đọc và ghi | Bộ nhớ, danh bạ, lịch hẹn, nhật ký, phiên đăng nhập |

- **Ba file cấu hình phải có trước lần chạy đầu.** Nếu thiếu, Docker tự tạo một *thư mục* trùng tên; bot coi như chưa cấu hình và vẫn chạy, nhưng bạn phải xoá thư mục đó rồi mới đặt được file thật.
- Sửa `.env`, `mcp.json` thì chạy `docker compose restart`. Sửa nội dung trong `workspace/` thì chỉ cần nhắn `/reload` cho bot.
- Cập nhật mã nguồn: `docker compose up -d --build`.
- Kênh `personal`: mã QR đăng nhập vẫn hiện ở `data/zalo-qr.png` trên máy bạn.
- Đăng nhập Google bằng OAuth (`npm run google-login`) cần trình duyệt nên phải chạy ngoài Docker một lần; cách dùng service account thì không cần.
- Ollama chạy trên máy chủ: đặt `OLLAMA_BASE_URL=http://host.docker.internal:11434/v1`.

## Log và thời hạn lưu

| Loại | Ở đâu | Dọn thế nào |
|---|---|---|
| Log hoạt động của bot | `data/logs/<ngày>.log`, mỗi ngày một file | Tự xoá khi cũ hơn `LOG_RETENTION_DAYS` ngày |
| Nhật ký tin nhắn | `data/messages/<ngày>/`, mỗi ngày một thư mục | Tự xoá cùng thời hạn trên |
| Log của Docker (`docker compose logs`) | Docker quản lý | Giới hạn theo dung lượng: 5 file × 10 MB |

`LOG_RETENTION_DAYS` mặc định là 30; đặt `0` để giữ mãi. Việc dọn chạy lúc khởi động và mỗi 6 giờ. Docker không tự xoá log theo tuổi được, nên phần của Docker chỉ giới hạn theo dung lượng.

Danh bạ, bộ nhớ, lịch sử trò chuyện và lịch hẹn không thuộc diện dọn này; chúng được giữ cho tới khi bạn xoá (lịch sử trò chuyện im lặng quá 90 ngày thì tự bỏ).

## Model

Chỉ cần điền khoá API vào `.env`. Khi `MODELS` để trống, bot tự dùng **model rẻ nhất** của mỗi nhà cung cấp có khoá, theo thứ tự Gemini, DeepSeek, Qwen, OpenAI, Ollama, và in danh sách đã chọn ra log lúc khởi động. Bot thử lần lượt: model trước lỗi, hết hạn mức hoặc không trả lời kịp thì tự chuyển sang model sau.

Vì tên model đổi liên tục, bot không ghi cứng tên nào: nó hỏi từng dịch vụ danh sách model mà khoá dùng được, rồi chọn theo tên của hạng rẻ nhất (OpenAI: `nano` rồi `mini`; DeepSeek: `flash` rồi `chat`; Qwen: `turbo` rồi `flash`; Ollama: model đầu tiên đã cài). Riêng Gemini dùng `gemini-flash-lite-latest`. Cách chọn này dựa trên tên chứ không đọc bảng giá, nên hãy nhìn log lần đầu để chắc bot chọn đúng ý bạn.

Muốn tự quyết thì liệt kê trong `MODELS`, mỗi mục là một trong ba dạng:

| Viết | Nghĩa | Ví dụ |
|---|---|---|
| Tên nhà cung cấp | Model rẻ nhất của họ | `deepseek` |
| `nhà-cung-cấp:tên-model` | Đúng model đó | `openai:gpt-5-mini`, `ollama:qwen3:8b` |
| Tên model Gemini | Model Gemini đó | `gemini-flash-latest` |

| Nhà cung cấp | Tên trong `MODELS` | Cần khai báo |
|---|---|---|
| Gemini | `gemini` | `GEMINI_API_KEY` |
| OpenAI | `openai` | `OPENAI_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Qwen (Alibaba Cloud) | `qwen` | `QWEN_API_KEY` |
| Ollama (chạy trên máy) | `ollama` | Không cần khoá; Ollama phải đang chạy |
| Dịch vụ khác tương thích OpenAI | tên tự đặt | `<TÊN>_BASE_URL` và `<TÊN>_API_KEY`; nên ghi rõ model |

Ví dụ: `MODELS=deepseek,gemini,openai:gpt-5-mini`. Mục nào thiếu khoá thì bị bỏ qua kèm cảnh báo lúc khởi động.

Model rẻ nhất cũng là model yếu nhất: dễ trả lời sai hoặc hứa suông hơn model hạng trên. Nếu thấy chất lượng chưa đạt, hãy ghi rõ một model mạnh hơn cho nhà cung cấp đứng đầu danh sách.

Mỗi lần gọi model có hạn 15 giây (Ollama: 180 giây); quá hạn thì bot chuyển sang model kế tiếp và cho model chậm nghỉ 15 phút. Đổi bằng `<TÊN>_TIMEOUT_SECONDS`, ví dụ `DEEPSEEK_TIMEOUT_SECONDS=30`.

Khi một khoá API hết tiền hoặc hết hạn mức trong ngày, bot ngừng dùng mọi model của khoá đó cho tới 0 giờ hôm sau (giờ Việt Nam), chuyển sang nhà cung cấp kế tiếp và nhắn cho tất cả admin đúng một lần. Việc chặn được lưu ở `data/blocked-keys.json` nên vẫn còn sau khi khởi động lại. Nạp thêm xong, admin nhắn `/unblock <tên>` để dùng lại ngay. Giới hạn theo phút (gọi quá nhanh) không bị coi là hết hạn mức: model chỉ nghỉ vài chục giây.

Model phải hỗ trợ gọi công cụ (function calling / tools), nếu không bot không tra được tài liệu. Với Ollama, hãy chọn model có nhãn "tools".

Khoá Gemini còn bật tìm kiếm vector cho tài liệu. Không có khoá Gemini, bot vẫn chạy nhưng chỉ tìm tài liệu theo từ khoá.

## Tuỳ biến bot không cần sửa mã

Dự án chia làm ba nơi, mỗi nơi một vai trò:

| Nơi | Chứa gì | Ai sửa |
|---|---|---|
| `workspace/` | Nội dung của bot: hướng dẫn hệ thống, quy trình, tài liệu, bảng hàng | Bạn |
| `.env`, `mcp.json`, `tools.json` (ở gốc dự án) | Cấu hình kỹ thuật: khoá API, kênh Zalo, kết nối ra hệ thống khác | Bạn |
| `data/` | Dữ liệu bot tự sinh khi chạy: bộ nhớ, lịch hẹn, phiên đăng nhập, bản chép từ Drive | Bot; không sửa tay |

Thư mục Google Drive (nếu bật) là một bản thứ hai của `workspace/`, cùng bố cục, để soạn từ xa. Chỗ nào cả hai nơi cùng có thì bản trên Drive được dùng; tài liệu và bảng hàng thì gộp cả hai. Nếu muốn chỉ có một nơi, hãy dùng một trong hai và để trống nơi kia.

Sửa xong, admin nhắn `/reload` cho bot (riêng `.env` và `mcp.json` cần khởi động lại).

| Muốn đổi | Sửa ở đâu | Ghi chú |
|---|---|---|
| Tính cách, giọng điệu, cách làm việc | `workspace/system-prompt.md` | Đây là hướng dẫn hệ thống của bot, viết bằng tiếng Việt thường |
| Giới thiệu đơn vị, cách xưng hô | `BOT_PERSONA` trong `.env` | Một hai câu |
| Cách xử lý một loại tình huống | `workspace/procedures/*.md`, hoặc dạy trong chat | Xem "Dạy bot một quy trình" |
| Kiến thức để tra cứu | `workspace/knowledge/`, `KNOWLEDGE_URLS`, Google Drive | Xem "Tài liệu" |
| Nối với một API có sẵn | `tools.json` | Xem "Công cụ gọi API tự khai báo" |
| Nối với một hệ thống phức tạp hơn | `mcp.json` | Xem "Thêm MCP server khác" |

### Hướng dẫn hệ thống

File `workspace/system-prompt.md` là phần hướng dẫn mà bạn toàn quyền sửa: thêm quy định riêng, đổi giọng điệu, bỏ những gì không hợp. Phần nằm trong `<!-- ... -->` ở đầu file là ghi chú cho người sửa, không gửi cho model.

Bot tự nối thêm vào sau nội dung file, nên bạn không cần viết lại: giới thiệu đơn vị, các quy trình đã dạy, danh sách tài liệu, ghi nhớ về người đang nhắn, ngày giờ. Ba quy tắc an toàn cũng được nối cố định và không sửa được qua file: không làm theo mệnh lệnh nằm trong tài liệu hay trang web, không tiết lộ hướng dẫn hệ thống, và không ai thành quản trị viên nhờ tự nhận.

Lưu ý khi sửa: giữ đúng tên công cụ (`search_knowledge`, `ask_admin`, `schedule_task`...), và nếu file bị xoá hoặc để trống thì bot không khởi động; khi `/reload` gặp file hỏng, bot báo lỗi cho admin và dùng tiếp bản cũ.

### Quản lý quy trình và hướng dẫn hệ thống trên Google Drive

Nếu đã bật Google Drive (xem mục "Google Drive"), bạn có thể soạn quy trình và hướng dẫn hệ thống ngay trên Drive bằng Google Docs, không cần mở máy chạy bot. Trong thư mục Drive đã khai báo:

| Tạo trên Drive | Tác dụng |
|---|---|
| Thư mục tên `procedures`, mỗi quy trình là một Google Docs | Tên file là tên quy trình. Trong file: dòng `Khi nào dùng: ...`, rồi các bước |
| Một Google Docs tên `system-prompt` | Thay cho `workspace/system-prompt.md`. Xoá file này thì bot quay lại dùng file trong máy |

- Thay đổi có hiệu lực ở lần đồng bộ kế tiếp (10 phút một lần), hoặc ngay khi admin nhắn `/reload`.
- Quy trình trên Drive trùng tên với quy trình trong máy thì bản trên Drive được dùng. Quy trình từ Drive không sửa hay xoá được từ khung chat; phải sửa trên Drive.
- Thư mục `listings` trên Drive là bảng hàng cho MCP server (xem "MCP: bảng hàng bất động sản"). Mọi thứ còn lại trên Drive, kể cả file để lẻ ở gốc và các thư mục tên khác, đều là tài liệu để tra cứu.
- **Ai sửa được thư mục Drive này thì điều khiển được bot**: họ có thể đổi hướng dẫn hệ thống và mọi quy trình. Chỉ cấp quyền chỉnh sửa cho người bạn tin như admin.
- Công cụ (`tools.json`, `mcp.json`) không đồng bộ từ Drive, vì chúng cho bot quyền gọi ra hệ thống khác; chúng chỉ được đặt trên máy chạy bot.

### Công cụ gọi API tự khai báo

Chép `tools.example.json` thành `tools.json` để cho bot gọi một API HTTP có sẵn (tra đơn hàng, tạo yêu cầu hỗ trợ, tra tồn kho...) mà không cần lập trình:

```json
{
  "tools": [
    {
      "name": "tra_don_hang",
      "description": "Tra trạng thái một đơn hàng theo mã đơn. Dùng khi khách hỏi đơn của họ đang ở đâu.",
      "audience": "all",
      "method": "GET",
      "url": "https://api.example.com/orders/{ma_don}",
      "headers": { "Authorization": "Bearer ${ORDER_API_KEY}" },
      "parameters": {
        "ma_don": { "type": "string", "description": "Mã đơn hàng", "required": true }
      }
    }
  ]
}
```

- `description` là thứ model đọc để quyết định khi nào gọi: viết rõ công cụ làm gì và dùng lúc nào.
- `{ten_tham_so}` trong `url` được thay bằng giá trị model đưa vào. Tham số không có trong `url` được gửi qua query (GET, DELETE) hoặc thân JSON (POST, PUT, PATCH).
- `${TEN_BIEN}` lấy giá trị từ `.env`, để khoá API không nằm trong `tools.json`.
- `audience` mặc định là `admin`. Chỉ đặt `all` cho những API mà khách nào gọi cũng được: khách có thể khiến bot gọi nó với tham số tuỳ ý, ví dụ tra mã đơn của người khác.
- Bot đọc tối đa 12.000 ký tự đầu của kết quả. Mục khai báo sai bị bỏ qua, kèm lý do trong log.

## Tài liệu

Bỏ file vào thư mục `workspace/knowledge/` (có thể chia thư mục con):

| Loại | Đuôi file |
|---|---|
| Văn bản | `.txt`, `.md` |
| Word | `.docx` |
| PDF | `.pdf` (PDF có chữ; bản scan ảnh không đọc được) |
| Excel | `.xlsx` |
| Bảng | `.csv` |
| Địa chỉ web | khai báo trong `KNOWLEDGE_URLS` dạng `Tên=URL`: trang web thường (lấy phần chữ), file tại URL (`.pdf`, `.docx`, `.xlsx`, `.csv`), Google Sheets và Google Docs chia sẻ "Bất kỳ ai có đường liên kết đều xem được". URL phải mở được công khai, không cần đăng nhập |
| Google Drive | thư mục hoặc file riêng tư, xem mục "Google Drive" bên dưới |

Với bảng tính, dòng đầu tiên được coi là tiêu đề cột. File `.doc` và `.xls` đời cũ không được hỗ trợ: hãy lưu lại thành `.docx` / `.xlsx`.

Kho tài liệu tự nạp lại mỗi 10 phút (đổi bằng `KNOWLEDGE_REFRESH_MINUTES`). Admin có thể nhắn `/reload` để nạp ngay.

File gốc luôn là nguồn chính, không bị chuyển đổi. Từ đó bot dựng một chỉ mục tìm kiếm kết hợp:

- **Từ khoá** (BM25, bỏ dấu tiếng Việt): mạnh với tên riêng, mã sản phẩm, con số.
- **Vector** (embedding của Gemini, lưu ở `data/embeddings.json`): mạnh với câu hỏi diễn đạt khác tài liệu, hoặc khác ngôn ngữ (hỏi tiếng Việt, tài liệu tiếng Anh).

Chỉ đoạn nào mới hoặc bị sửa mới được tính vector lại. Nếu dịch vụ embedding lỗi, bot tự lùi về tìm theo từ khoá.

Admin cũng có thể dạy bot ngay trong khung chat, ví dụ: "Ghi nhớ vào kho tài liệu: phí môi giới là 1% giá trị hợp đồng". Bot lưu vào `workspace/knowledge/ghi-chu-admin.md` và từ đó trả lời được cho mọi khách.

### Dạy bot một quy trình

Tài liệu là thứ bot *tra cứu* khi cần. Quy trình là thứ bot *phải làm theo* mỗi khi gặp một loại tình huống: cần hỏi gì, tra gì, trả lời ra sao, khi nào chuyển cho người thật. Quy trình luôn nằm sẵn trước mắt bot ở mọi tin nhắn, nên không phụ thuộc vào việc tìm kiếm có ra hay không.

Admin dạy ngay trong khung chat, bằng lời thường:

> Dạy em quy trình: khi khách hỏi báo giá làm phần mềm thì 1) hỏi một lượt: loại phần mềm, tính năng chính, thời hạn, ngân sách, số điện thoại. 2) đủ thông tin thì báo giá sơ bộ: web từ 30 triệu, app từ 80 triệu. 3) chuyển cho anh chốt giá và báo khách trong 24h sẽ có người gọi.

Bot viết lại thành các bước, lưu thành một file trong `workspace/procedures/`, rồi tóm tắt lại để bạn kiểm tra. **Hãy đọc bản tóm tắt đó**: bot có thể diễn đạt lại hoặc thêm ý; chỗ nào sai thì nhắn sửa, hoặc mở file ra sửa tay.

- Dạy lại cùng tiêu đề thì quy trình cũ bị thay thế. Muốn bỏ thì bảo bot xoá quy trình đó.
- Nhắn `/procedures` để xem danh sách. Khách thường không dạy hay sửa được quy trình.
- Mỗi quy trình là một file Markdown, sửa tay được, rồi nhắn `/reload`:
  ```
  # Tên quy trình
  Khi nào dùng: tình huống áp dụng

  1. Bước một...
  2. Bước hai...
  ```
- Quy trình nên ngắn và cụ thể. Khi tổng độ dài vượt khoảng 8.000 ký tự, bot chỉ giữ sẵn tiêu đề và phải tự mở từng quy trình ra đọc, kém chắc chắn hơn.

### Google Drive

Bot có thể lấy tài liệu từ các thư mục trên Google Drive, kể cả file riêng tư. Bot chỉ xin quyền **đọc** Drive. Có hai cách cho bot đăng nhập Google; chỉ cần một.

**Cách 1 (khuyên dùng): service account.** Đây là một "tài khoản robot" có email riêng. Không cần đăng nhập bằng trình duyệt, không hết hạn, và bot chỉ thấy đúng những thư mục bạn chia sẻ cho nó.

1. Vào [Google Cloud Console](https://console.cloud.google.com), chọn project và bật **Google Drive API** (APIs & Services → Library).
2. Tạo service account (IAM & Admin → Service Accounts), hoặc dùng cái đã có.
3. Mở service account → thẻ **Keys** → **Add key** → **Create new key** → **JSON**. Trình duyệt tải về một file `.json`.
4. Chép file đó vào `data/google-service-account.json`.
5. Trên Google Drive, **chia sẻ thư mục** cho email của service account (dạng `ten@project.iam.gserviceaccount.com`) với quyền **Người xem**.
6. Điền vào `.env` rồi khởi động lại bot:
   ```
   GOOGLE_SERVICE_ACCOUNT_FILE=data/google-service-account.json
   GOOGLE_DRIVE_FOLDERS=https://drive.google.com/drive/folders/...
   ```

Bot cần cả file JSON vì trong đó có `private_key`. Email, Client ID và Key ID của service account chỉ là thông tin định danh, không đủ để đăng nhập.

**Cách 2: đăng nhập bằng tài khoản Google của bạn (OAuth).** Bot thấy mọi thứ tài khoản đó thấy.

1. Trong Google Cloud Console, bật **Google Drive API**, cấu hình OAuth consent screen loại **External** và thêm tài khoản của bạn vào **Test users**.
2. Tạo **OAuth client ID** loại **Desktop app**, điền `GOOGLE_OAUTH_CLIENT_ID` và `GOOGLE_OAUTH_CLIENT_SECRET` vào `.env`, cùng `GOOGLE_DRIVE_FOLDERS`.
3. Chạy `npm run google-login`, đăng nhập trong trình duyệt và bấm cho phép, rồi khởi động lại bot.

Với cách 2, ứng dụng ở trạng thái "Testing" thì đăng nhập hết hạn sau 7 ngày; muốn dùng lâu dài phải chuyển sang **In production** rồi đăng nhập lại.

Tên các mục trong Google Cloud Console có thể khác đôi chút tuỳ thời điểm.

Cách hoạt động:

- `GOOGLE_DRIVE_FOLDERS` nhận nhiều đường dẫn thư mục hoặc file, cách nhau bằng dấu phẩy. Thư mục con được quét theo.
- Bot chép các file đọc được về `data/drive/` rồi lập chỉ mục như tài liệu thường. Trong câu trả lời, nguồn hiện dưới dạng `Drive/<tên file>`.
- Google Docs và Slides được lấy dưới dạng văn bản, Google Sheets dưới dạng Excel. File tải lên Drive thì nhận `.pdf`, `.docx`, `.xlsx`, `.csv`, `.txt`, `.md`. Ảnh, video, file trên 30 MB bị bỏ qua.
- Mỗi lần nạp lại kho tài liệu (10 phút một lần, hoặc `/reload`), bot chỉ tải file mới hoặc đã sửa, và gỡ file đã bị xoá trên Drive. Nếu không kết nối được Drive, bot dùng bản đã chép lần trước.
- Lúc khởi động, log có dòng `[drive] N file trên Drive (...)` khi đồng bộ được. Nếu thấy `Drive is off` hoặc `Drive API 404`, đọc phần sau dấu `->` để biết thiếu gì; 404 gần như luôn là thư mục chưa được chia sẻ cho bot.

Lưu ý:

- File khoá service account và `data/google-token.json` đều cho phép đọc Drive. Giữ chúng như mật khẩu; thư mục `data/` không được đưa vào git.
- Bot đọc được mọi thứ trong các thư mục đã khai báo và có thể trích lại cho khách. Đừng để tài liệu nội bộ nhạy cảm trong đó.

## Bộ nhớ

| Loại | Lưu ở | Cách hoạt động |
|---|---|---|
| Lịch sử trò chuyện | `data/conversations.json` | Giữ nguyên văn các tin gần nhất; phần cũ hơn được gộp thành bản tóm tắt thay vì bị quên. Cuộc trò chuyện im lặng quá 90 ngày thì bị xoá. |
| Ghi nhớ về từng người | `data/memories.json` | Bot tự ghi lại điều đáng nhớ (tên, nhu cầu, ngân sách...), tối đa 30 ý mỗi người. Không dùng trong nhóm chat. |
| Lịch hẹn | `data/tasks.json` | Xem mục "Chủ động" bên dưới. |

Tất cả còn nguyên sau khi khởi động lại. Ai cũng có thể nhắn `/forget` để xoá lịch sử và ghi nhớ về mình.

## Chủ động

Bot có thể tự làm việc vào lúc khác mà không cần ai nhắn: nhắc lịch ("nhắc tôi 9h mai gọi chủ nhà"), hỏi thăm lại khách, gửi thông tin hằng ngày hoặc hằng tuần. Đến giờ, bot được gọi lại với nội dung công việc, có thể tra cứu rồi tự soạn và gửi tin. Mỗi cuộc trò chuyện có tối đa 10 lịch hẹn.

## Người dùng, nhóm và nhật ký tin nhắn

Bot ghi lại mọi người và mọi nhóm nó gặp, cùng toàn bộ tin nhắn, mà không gọi model nên không tốn token:

| Lưu gì | Ở đâu | Nội dung |
|---|---|---|
| Người dùng và nhóm | `data/contacts.json` | Tên, ID, lần đầu và lần cuối gặp, số tin, đã nhắn riêng cho bot chưa, có nhận thông báo không; với nhóm: những ai đã nhắn |
| Mọi tin nhắn đến và đi | `data/messages/<ngày>/<kênh>-<hội thoại>.jsonl` | Mỗi dòng một tin: thời điểm, người gửi, loại, nội dung. Kể cả tin trong nhóm mà bot không trả lời, và tin không phải chữ |

Admin nhắn `/users` hoặc `/groups` (trong chat riêng với bot) để xem danh sách.

### Bot trong nhóm và cộng đồng

- Tin nào trong nhóm cũng được ghi vào nhật ký. Bot chỉ gọi model khi tin đó dành cho nó.
- Trên kênh `personal`, "dành cho bot" nghĩa là có @mention bot. Trên kênh `bot`, nền tảng Zalo quyết định chuyển tin nào cho bot (theo tài liệu là các tin @mention bot); tin nào được chuyển tới thì bot coi là dành cho nó.
- Mỗi nhóm có trần số lần trả lời mỗi giờ: `GROUP_REPLIES_PER_HOUR`, mặc định 30. Vượt trần thì bot chỉ ghi nhật ký. Đặt `0` để bot chỉ lắng nghe trong nhóm, không bao giờ trả lời.
- Khi được hỏi trong nhóm, bot được xem 15 tin gần nhất của nhóm đó để hiểu mọi người đang nói về gì. Số tin này lấy từ bộ nhớ đang chạy, nên ngay sau khi khởi động lại bot chưa có ngữ cảnh nhóm.
- Lệnh của admin không chạy trong nhóm, để danh sách người dùng không bị lộ ra đó.

Nhật ký tin nhắn chứa nội dung trò chuyện của khách: hãy bảo vệ thư mục `data/`. Nhật ký cũ hơn 30 ngày tự bị xoá (xem "Log và thời hạn lưu").

### Gửi thông báo hàng loạt

Admin có thể gửi một tin tới mọi người dùng, mọi nhóm, hoặc cả hai. Không có tin nào đi ngay sau một câu lệnh: bot luôn soạn **bản nháp** kèm số nơi nhận và một mã, và chỉ gửi khi admin tự nhắn `/confirm <mã>`.

```
/broadcast Cuối tuần này cửa hàng nghỉ lễ.          → gửi cho người dùng
/broadcast groups Tối nay 20h có livestream.         → gửi cho các nhóm
/broadcast all ...                                   → cả hai
/confirm 4821                                        → gửi (hoặc /cancel 4821 để huỷ)
```

Cũng có thể nói bằng lời thường ("gửi cho mọi người thông báo ...", "9h sáng mai gửi ..."); bot soạn bản nháp và vẫn chờ `/confirm`.

- "Người dùng" là những ai đã từng nhắn riêng cho bot. Người chỉ gặp trong nhóm không được nhắn riêng.
- Ai cũng có thể nhắn `/stop` để thôi nhận thông báo chung (vẫn hỏi đáp bình thường), và `/start` để nhận lại.
- Tin được gửi lần lượt, mỗi nơi cách nhau nửa giây. Gửi xong bot báo số thành công và số lỗi cho admin.
- Bản nháp hết hạn sau 30 phút, và mỗi mã chỉ dùng được một lần.
- Trên kênh `personal`, gửi hàng loạt làm tăng rủi ro bị Zalo khoá tài khoản. Hãy gửi thưa và nội dung có ích.

### Lịch làm việc tự động

Ngoài việc nhắc lịch cho từng người, admin có thể hẹn giờ cho hai việc hệ thống, một lần hoặc lặp lại hằng ngày, hằng tuần. Cả hai chạy trực tiếp, không gọi model, và báo kết quả vào chat của admin đã đặt lịch:

| Việc | Cách đặt | Ghi chú |
|---|---|---|
| Nạp lại tài liệu và cấu hình | Nói với bot, ví dụ "6h sáng mỗi ngày tự reload nhé" | Giống lệnh `/reload` |
| Gửi thông báo hàng loạt | "9h sáng mai gửi cho mọi người: ..." rồi `/confirm <mã>` | Lịch chỉ được tạo sau khi xác nhận |

Xem và huỷ lịch bằng cách bảo bot ("liệt kê các lịch hẹn", "huỷ lịch 3"). Lịch được lưu ở `data/tasks.json` nên vẫn còn sau khi khởi động lại; lịch được kiểm tra mỗi 20 giây.

## Quản trị viên

1. Nhắn `/id` cho bot để lấy ID của bạn.
2. Ghi vào `.env`: `ADMINS=bot:<id>` (nhiều người thì cách nhau bằng dấu phẩy), rồi khởi động lại.

Khi bot không tìm được câu trả lời, hoặc khách muốn gặp người hỗ trợ, bot gửi cho admin đầu tiên trong danh sách một tin dạng:

```
[Cần hỗ trợ #12]
Người hỏi: Lan (kênh personal)
Câu hỏi: Có hỗ trợ trả góp không?
Trả lời bằng cách nhắn: #12 <nội dung>
```

Admin nhắn lại `#12 Có, trả góp 0% qua thẻ tín dụng` và bot chuyển nguyên văn cho khách. Admin và khách có thể ở hai kênh khác nhau.

Lệnh trong khung chat:

| Lệnh | Ai dùng | Tác dụng |
|---|---|---|
| `/help` | Mọi người | Xem các lệnh |
| `/id` | Mọi người | Xem ID của mình và của hội thoại |
| `/forget` | Mọi người | Xoá lịch sử trò chuyện và ghi nhớ về mình |
| `/stop`, `/start` | Mọi người | Tắt, bật nhận thông báo chung |
| `/users`, `/groups` | Admin | Danh sách người dùng và nhóm bot đã gặp |
| `/broadcast [users\|groups\|all] <nội dung>` | Admin | Soạn bản nháp thông báo hàng loạt |
| `/confirm <mã>`, `/cancel <mã>` | Admin | Gửi hoặc huỷ một bản nháp thông báo |
| `/reload` | Admin | Nạp lại kho tài liệu |
| `/procedures` | Admin | Xem các quy trình đã dạy cho bot |
| `/tickets` | Admin | Xem các câu hỏi đang chờ trả lời |
| `/keys` | Admin | Xem model đang dùng và khoá API nào đang bị chặn |
| `/unblock <tên>` | Admin | Mở lại một khoá API sau khi nạp thêm, ví dụ `/unblock deepseek` |
| `#<mã> <nội dung>` | Admin | Trả lời một câu hỏi đang chờ |

## Công cụ của AI

| Công cụ | Ai kích hoạt được | Tác dụng |
|---|---|---|
| `search_knowledge` | Mọi người | Tìm đoạn liên quan trong kho tài liệu |
| `read_document` | Mọi người | Đọc nguyên văn một phần tài liệu |
| `add_knowledge_note` | Admin | Thêm kiến thức mới vào kho tài liệu |
| `save_procedure`, `delete_procedure` | Admin | Dạy, sửa và xoá quy trình xử lý |
| `web_search` | Mọi người (`WEB_AUDIENCE=admin` để chỉ admin dùng, `off` để tắt) | Tìm kiếm web. Dùng Google Search qua Gemini nếu khoá Gemini đã bật thanh toán; nếu không thì dùng DuckDuckGo, không cần khoá |
| `fetch_url` | Như trên | Đọc một trang web công khai; chặn địa chỉ nội bộ |
| `save_memory`, `delete_memory` | Mọi người | Ghi và xoá ghi nhớ về người đang nhắn |
| `schedule_task`, `list_tasks`, `cancel_task` | Mọi người | Hẹn việc, xem và huỷ lịch hẹn |
| `schedule_reload` | Admin | Hẹn giờ nạp lại tài liệu và cấu hình |
| `draft_broadcast` | Admin | Soạn bản nháp thông báo hàng loạt (không tự gửi) |
| `ask_admin` | Mọi người (khi có `ADMINS`) | Chuyển câu hỏi cho quản trị viên |
| Công cụ MCP | Admin, trừ khi server đặt `"audience": "all"` | Tuỳ server |

### MCP: bảng hàng bất động sản

Dự án kèm sẵn một MCP server ở `mcp/real-estate.ts`, khai báo trong `mcp.json` (mẫu: `mcp.example.json`) với tên `bds`:

| Công cụ | Tác dụng |
|---|---|
| `search_listings` | Lọc căn đang mở bán theo khu vực, loại, giá, số phòng ngủ, diện tích, từ khoá |
| `get_listing` | Xem đầy đủ một căn theo mã |
| `save_lead` | Ghi khách quan tâm (tên, số điện thoại, nhu cầu...) vào `data/leads.csv` |
| `calculate_loan` | Tính trả góp hằng tháng: trả đều và dư nợ giảm dần |

Bảng hàng lấy từ `LISTINGS_SOURCE` trong `mcp.json`, là danh sách cách nhau bằng dấu phẩy gồm file `.csv` / `.xlsx`, thư mục chứa các file đó, hoặc URL Google Sheets chia sẻ "Bất kỳ ai có đường liên kết". Mặc định là hai thư mục `workspace/listings` và `data/drive/listings` (thư mục `listings` trên Drive), nên bạn chỉ cần thả file Excel vào một trong hai nơi. Bot đọc mọi file trong thư mục và mọi trang của mỗi file Excel; tên file (và tên trang) được ghi vào cột "Nguồn" của từng căn nên tìm theo tên dự án đặt ở tên file cũng ra. Mọi bảng cần chung một kiểu tiêu đề cột như bên dưới. Khi cả hai thư mục đều trống, bot trả lời khách là chưa có căn nào để giới thiệu.

Bảng hàng cần dòng đầu là tiêu đề cột. Bot nhận ra các cột theo từ khoá trong tiêu đề, các cột khác vẫn được hiển thị nguyên:

| Cột | Tiêu đề phải chứa | Ghi chú |
|---|---|---|
| Mã căn | `Mã` | Cần cho `get_listing` |
| Loại hình | `Loại` | Ví dụ: Căn hộ, Nhà phố, Đất nền |
| Giá | `Giá` | Tính bằng tỷ đồng (`2.8`), hoặc ghi `850 triệu`, hoặc số đồng đầy đủ |
| Diện tích | `Diện tích` | m2 |
| Phòng ngủ | `Phòng ngủ` | |
| Tình trạng | `Tình trạng` | Dòng ghi "Đã bán", "Đã cọc", "Ngừng" hoặc "Hết hàng" bị ẩn |

File được đọc lại mỗi khi nó thay đổi; Google Sheets được làm mới mỗi 5 phút. Sửa `mcp.json` thì phải khởi động lại bot.

### Thêm MCP server khác

Khai báo thêm trong `mcp.json` (chạy bằng lệnh hoặc qua URL). Công cụ MCP mặc định chỉ admin dùng được, vì chúng có thể thao tác lên hệ thống thật; chỉ đặt `"audience": "all"` cho server chỉ đọc hoặc chỉ có những thao tác ghi rất hẹp như `save_lead`.

## Lệnh phát triển

| Lệnh | Tác dụng |
|---|---|
| `npm start` | Chạy bot |
| `npm run dev` | Chạy và tự khởi động lại khi sửa mã |
| `npm run typecheck` | Kiểm tra kiểu TypeScript |
| `npm run google-login` | Đăng nhập Google một lần để bot đọc được Drive |

## Cấu trúc

```
src/
  index.ts            Điểm khởi động: nối kênh, lệnh, agent
  config.ts           Đọc cấu hình từ biến môi trường
  channels/           Lớp bọc hai kênh Zalo (types, bot, personal, hub)
  store.ts            Lưu dữ liệu JSON ra đĩa
  contacts.ts         Danh sách người dùng và nhóm bot đã gặp
  message-log.ts      Nhật ký mọi tin nhắn đến và đi
  retention.ts        Ghi log ra file theo ngày và xoá log quá hạn
  broadcast.ts        Thông báo hàng loạt: bản nháp, xác nhận, gửi
  google-login.ts     Lệnh đăng nhập Google
  google/auth.ts      OAuth của Google: đăng nhập, làm mới token
  ai/
    agent.ts          Vòng lặp: model lập kế hoạch, gọi công cụ, đọc kết quả, lặp lại
    models.ts         Chọn model, tự chuyển khi lỗi, hết hạn mức hoặc quá chậm
    providers.ts      Kết nối Gemini và các dịch vụ tương thích OpenAI
    embeddings.ts     Vector hoá văn bản, có bộ đệm trên đĩa
    memory.ts         Lịch sử trò chuyện và ghi nhớ dài hạn
    prompt.ts         Ghép hướng dẫn hệ thống từ file với phần do mã sinh ra
    tools.ts          Kiểu Tool và phân quyền
  tools/
    knowledge.ts      Đọc, chia đoạn và tìm kiếm tài liệu
    drive.ts          Chép tài liệu từ Google Drive về máy
    procedures.ts     Quy trình xử lý do admin dạy
    http-tools.ts     Công cụ gọi API khai báo trong tools.json
    web.ts            Tìm kiếm web, đọc trang web
    scheduler.ts      Lịch hẹn và tác vụ định kỳ
    admin.ts          Chuyển câu hỏi cho admin, nhận câu trả lời
    mcp.ts            Kết nối MCP server
mcp/
  real-estate.ts      MCP server: bảng hàng, ghi khách, tính khoản vay
workspace/            Mọi nội dung bạn tự soạn
  system-prompt.md    Hướng dẫn hệ thống
  procedures/         Quy trình đã dạy cho bot (mỗi quy trình một file)
  knowledge/          Tài liệu để tra cứu
  listings/           Bảng hàng (.xlsx / .csv)
data/                 Dữ liệu bot tự sinh: phiên đăng nhập, bộ nhớ, lịch hẹn, chỉ mục vector,
                      bản chép từ Drive (không commit, không sửa tay)
```

## Lưu ý vận hành

- Trong nhóm, bot chỉ trả lời khi được @mention.
- Bot chỉ xử lý tin nhắn chữ, kể cả emoji. Ảnh, sticker, tin thoại, file và video không được xử lý: trong chat riêng bot nhắn lại một câu báo như vậy, trong nhóm thì bỏ qua. Bot chỉ gửi văn bản.
- **Hạn mức:** mỗi tin nhắn tốn 2-4 lượt gọi model. Khoá Gemini miễn phí chỉ có khoảng 20 lượt mỗi ngày cho mỗi model Flash. Khi mọi model trong `MODELS` đều hết lượt, bot báo cho người dùng và ghi `[models]` vào log; log cũng cho biết model nào đã trả lời mỗi lượt và mất bao lâu.
- Thư mục `data/` chứa thông tin cá nhân của khách (lịch sử, ghi nhớ). Hãy sao lưu và bảo vệ nó như dữ liệu khách hàng.
- Kênh `personal` gửi tin lần lượt, có độ trễ ngẫu nhiên để tránh hành vi giống máy.
- Mỗi tài khoản cá nhân chỉ có một phiên Zalo Web được nghe tin; mở Zalo Web ở nơi khác sẽ ngắt bot.
- Không commit `.env`, `mcp.json` và thư mục `data/`.
