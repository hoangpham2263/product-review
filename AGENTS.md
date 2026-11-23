# Hướng dẫn và bài học của dự án

Áp dụng cho Product Review (repo `hoangpham2263/product-review`, tách từ Tools Hub). Đọc trước khi sửa workflow, prompt, giao diện hoặc dữ liệu mẫu.

## 0. Cấu trúc

- Gốc repo là app: `src/`, `data/`, `tests/`, `workspace/` (Git bỏ qua: cấu hình, ảnh nguồn đã tải, kết quả, log, báo cáo lỗi). `core/` là phần hạ tầng: gọi AI (`core/ai`), Cấu hình (`core/setup`), cửa sổ Windows (`core/launch.ps1`, WebView2), cập nhật (`core/update.ps1`).
- Ảnh nguồn: repo công khai `hoangpham2263/product-review-sources` (`source-photos/manifest.json` nhóm/bật/tắt/md5, `catalog.json` nguồn ảnh); app đọc link raw, tải theo nhóm vào `workspace/source-photos/<nhóm>/` (`src/infrastructure/source-sync.ps1`). Thêm/bật nhóm là sửa repo đó, không có trang quản lý.
- Ảnh kết quả: repo `hoangpham2263/product-review-results`, ghi qua Worker `product-review-api` (`worker/`, secret `GITHUB_TOKEN` chỉ có quyền ghi repo đó). App không có mật khẩu; Worker chỉ nhận PNG ≤ 20 MB và trả link raw cho CSV (`src/infrastructure/result-storage.ps1`).
- Báo lỗi: AI viết một file vào `workspace/reports/` trên máy, không gửi đi đâu.
- Quét web: nút "Quét web" (popup trong app) cho Claude mở một web shop trong Chrome riêng của app, đọc menu, lấy sản phẩm (tối đa N mỗi danh mục) và ảnh chính, lưu vào **dự án** của web đó (`workspace/projects/<id>/`: `project.json`, `menu.json`, `products.csv` + `images/` theo khuôn Nhập hàng loạt, thêm cột `title`, `collection`, `used`, `reviews_count`, `reviews_checked_at`); quét lại web đã có chỉ thêm sản phẩm mới (không xoá gì, giữ `used` và số review). Prompt: `docs/scan-prompt.md`; CLI chỉ làm phần cơ học: `src/scan.ps1` (start, known, add, add-many, set-menu, status, finish, projects, project, set-used, reviews-todo, set-reviews) và `src/application/scan-store.ps1`; chạy qua cùng runner với Claude (Flow) (`core/setup/agent-run.mjs`, mode `scan`, `/api/scan/*`), một lượt agent một lúc vì dùng chung một profile Chrome. Claude tự đọc trang, không dùng script quét cố định (web đổi giao diện sẽ treo). `used`: F khi mới quét; link chạy xong (checkpoint Codex, `finish` của agent) tự đặt T (`Set-ScanUsed`); Nhập hàng loạt bỏ qua dòng T và báo "bỏ qua N dòng đã dùng". `review_images` và `sign_text` để trống: người dùng chọn ảnh review và chữ trên biển.
- Dự án: nút "Dự án" (popup) liệt kê các dự án (mỗi web một dự án, id = host), xem sản phẩm theo danh mục / chưa dùng, bật tắt `used` T/F, "Quét cập nhật", "Cập nhật số review", "Nhập vào danh sách". Cập nhật số review (`docs/reviews-count-prompt.md`, mode `reviews`, `/api/project/reviews/*`) chỉ ĐỌC: Claude mở từng link trong Chrome riêng và đọc số review trang đó hiển thị rồi ghi bằng `set-reviews`. Không có code nào tìm hay phân tích số review (không selector, không regex, không nhận diện widget theo từng web); code chỉ lưu số Claude báo và liệt kê link (`reviews-todo`). Dự án chỉ lưu số đã quan sát; không có mục tiêu hay số review còn thiếu, và Claude không bao giờ viết, gửi, sửa hay bình chọn review. Một lượt agent một lúc (Flow, quét, cập nhật review dùng chung một profile Chrome). Biến PowerShell trong `scan.ps1` không đặt tên trùng tham số (`$project`, `$used`, `$count`...): không phân biệt hoa thường và tham số có kiểu `[string]`. "Thêm vào hàng chờ" (popup Dự án, mode `queue`, `docs/queue-prompt.md`, `/api/project/queue/*`) chỉ CHUẨN BỊ hàng chờ cho dự án đang chọn: link vào `urls.txt`, ảnh gốc từ `images/` của dự án và N ảnh bối cảnh khác nhau (ô "Ảnh ngữ cảnh / sản phẩm", 1-4, mặc định 2) do Claude tự chọn từ kho (nhìn ảnh sản phẩm trước, đúng nhóm: Áo / Thể thao ngoài trời / Nội thất, báo sản phẩm không có cảnh hợp thay vì chọn bừa) vào `references.json` đúng khuôn entry của app. Ô ảnh ngữ cảnh = 0: không chạy Claude, `/api/project/queue/direct` (`queue-direct`) thêm ngay N sản phẩm đầu bảng (cùng thứ tự CSV và bộ lọc) chỉ với link và ảnh gốc. Không có code ghép cảnh; CLI `scan.ps1` (`queue-todo`, `scenes`, `scene-get`, `queue-add`) chỉ liệt kê, tải, kiểm md5/sha256 và ghi entry; kiểm ảnh cảnh bằng perceptual hash (`image-phash.ps1`, ngưỡng 20/256): `scenes` báo `used_count`/`dup_of`, `queue-add` từ chối `SCENE_DUPLICATE` (2 cảnh của 1 sản phẩm giống nhau) và `SCENE_REUSED` (cảnh đã dùng cho sản phẩm khác trong hàng chờ/5 lượt gần nhất, trừ khi `-AllowReuse`); Claude vẫn tự chọn, không có code ghép cảnh; một cảnh không dùng lại giữa các sản phẩm trong một batch; không sửa entry hay dòng đã có; không tạo ảnh, không viết review. Test: `tests/project-store.ps1`.
- Phát hành: push tag `vX.Y.Z` → Release `product-review.zip`; Cập nhật thay file, giữ `workspace/` và gộp bài học `AGENTS.md`. Trang tải: `docs/index.html` (GitHub Pages), chỉ có nút tải.
- Chỉ nói đã cập nhật Git sau commit/push thành công. Không đưa `workspace/` hay ảnh vào Git. Yêu cầu mới nhất của người dùng có ưu tiên cao nhất; cập nhật quy tắc cũ khi yêu cầu thay đổi, không giữ chỉ dẫn mâu thuẫn.

## 1. Workflow hiện tại

1. Nhận URL và ảnh tham khảo gắn riêng cho từng sản phẩm; kiểm tra link trùng, ảnh thiếu và file/hash trước khi gọi AI.
2. Nếu người dùng gắn ảnh sản phẩm gốc, kiểm tra file/hash rồi dùng trực tiếp, không truy cập web kể cả link chưa public; nếu không có ảnh gốc thì tải từ URL. Nhận diện từ ảnh thực tế. Ảnh bối cảnh là đầu vào riêng, không nhầm với ảnh sản phẩm. Ảnh review luôn do người dùng chọn (từ máy hoặc kho ảnh); app không tự tìm trong kho.
3. Lưu snapshot đầu vào và nguồn vào kết quả của lượt đang chạy. Đọc các bài học còn bật, khớp URL hoặc danh mục từ mục Bài học đã lưu bên dưới; áp dụng yêu cầu sửa hiện tại sau cùng.
4. Tạo một ảnh hoàn chỉnh, kiểm tra PNG đọc được rồi xuất nguyên file AI tạo. Không chấm chất lượng bằng AI sau tạo, không tự sửa hoặc lặp tạo để cải thiện thẩm mỹ.
5. Viết review mẫu theo ảnh hiện tại, học cách diễn đạt từ kho review tham khảo chung rồi xuất ảnh và CSV. Giữ URL chưa hoàn tất để thử lại. Có ảnh xuất chưa có nghĩa người dùng đã duyệt.
6. Người dùng duyệt từng ảnh (Giữ/Bỏ) rồi xuất file Loox; app không có bước làm lại ảnh.

Chỉ tự thử lại lỗi kết nối/timeout khi chưa nhận đủ file, tối đa 3 lượt gửi với cùng đầu vào. Phải xác nhận tiến trình cũ đã dừng, tìm ảnh đã lưu trước khi gửi lại; có ảnh thì xuất, không tạo trùng. Lỗi đăng nhập, hết hạn mức hoặc đầu vào sai không tự thử lại. Không chạy lại ảnh hay test khi người dùng đã yêu cầu bỏ qua.

CLI exit 0 không xác nhận công cụ tạo ảnh thành công. Giữ console/tool log đến khi PNG được xác minh; thiếu/hỏng PNG phải đọc lỗi công cụ, ưu tiên payload có cấu trúc. `usage_limit_reached` báo `QUOTA`, giữ HTTP status, thông báo và reset do dịch vụ trả về, không retry. Không có bằng chứng lỗi thì báo thiếu/hỏng output, nguyên nhân chưa rõ. Quota không đọc được là chưa xác định; hạn mức Codex hiển thị không chứng minh công cụ tạo ảnh còn lượt.
Codex Windows sandbox: mỗi `-C WorkDir` có capability SID riêng (`~/.codex/cap_sid`), `setup refresh` cấp quyền ghi lúc khởi động. Với WorkDir MỚI mà nhiều codex khởi động song song, các refresh đè nhau: gốc batch có SID đúng nhưng `images/refs/logs` giữ SID cũ nên Codex bị Access denied khi lưu vào `images` (ảnh vẫn sinh ở `~/.codex/generated_images/<thread>/`, job ra `[CAUSE:OUTPUT_MISSING]`). Tool xử lý: (1) `New-Batch -WarmCodex` gọi `Initialize-CodexWorkDir` (core/ai/providers/codex.ps1): một `codex exec` nhỏ tuần tự (`-s workspace-write -C <batch>`, 90s) rồi mới tạo `images/refs/logs` và chạy song song; lỗi warm-up chỉ ghi log. (2) Sau đó so SID có quyền Modify (icacls) ở gốc và từng thư mục con; lệch mà thư mục rỗng thì xoá-tạo lại, không rỗng thì chỉ cảnh báo; ghi `logs/codex-setup.log`. (3) `Find-CodexGeneratedImage` (dùng trong `Invoke-ImageGeneration`): job thiếu output thì lấy thread id trong console.log của chính job, chỉ nhận PNG hợp lệ nằm đúng `generated_images/<thread>/`, tên có trong trace, mới ghi sau lúc job bắt đầu; chép về đường dẫn kết quả rồi kiểm PNG như thường. PNG lẻ ở gốc batch (kiểu `008-temp.png`) không dùng vì không gắn được với job.

## 2. Đúng sản phẩm và từng chi tiết

- Ảnh sản phẩm quyết định thiết kế, cấu tạo, vật liệu, màu, vân và các thành phần bán kèm. Đọc ảnh đầu vào hiện tại, không chỉ suy luận từ tên hoặc handle.
- Chú ý chi tiết, không chỉ giống tổng thể. Với áo: hình cổ, mép viền, thứ tự màu, số/độ rộng sọc, đường may, nút, nẹp, mảng phối và vị trí logo. Với nội thất: hình dáng, cạnh, độ dày, vân, chân đỡ, lưng/mặt ghế và tỉ lệ. Đưa đặc điểm nhìn thấy cụ thể vào yêu cầu tạo ngay từ đầu.
- Không thêm/bớt hoặc đơn giản hóa chi tiết để ảnh trông đẹp hơn. Không lấy thiết kế sản phẩm từ áo của người mẫu hay đồ trong phòng tham khảo. Góc nhìn và ánh sáng có thể đổi cách hiển thị, không đổi cấu tạo.
- Xác định bàn riêng hay cả bộ từ nguồn; không mặc định có ghế bán kèm hoặc luôn có 12 ghế. Ghi nhận giới hạn của ảnh nguồn; không bịa chi tiết bị che khuất.
- Không hứa giữ chính xác 100% hình dáng/vân chỉ vì prompt có yêu cầu. Khi được yêu cầu kiểm tra ảnh, đối chiếu thực tế và nêu rõ phần chưa xác minh.

## 3. Bối cảnh tự nhiên và ghế đi kèm

- Ảnh tham khảo cung cấp người, không gian, góc máy và ánh sáng; không thay thế thiết kế sản phẩm.
- Với nội thất, dùng ảnh phòng có sẵn làm nền chỉnh sửa. Giữ canvas, góc máy, tường, sàn, cửa, cửa sổ và đồ không liên quan. Chỉ đổi sản phẩm, vùng nền nhỏ lộ ra khi bỏ đồ cũ và bóng tiếp xúc cần thiết.
- Không có trong ảnh gốc thì không tự thêm để dàn cảnh: giữ mặt bàn trống nếu vốn trống, không mang bát đĩa, cây, sách, người hay đồ trang trí từ ảnh sản phẩm sang phòng. Gợi ý trang trí do AI viết trong context không phải yêu cầu người dùng.
- Nếu bán cả bộ, thay đủ bàn và ghế theo nguồn; không chỉ đổi mặt bàn rồi giữ ghế cũ sai kiểu. Theo yêu cầu người dùng, các chỗ ngồi hiện có ngay quanh bàn cũng cần đồng bộ phong cách và chiều cao sử dụng, kể cả khi chỉ bán bàn; không suy ra chúng được bán kèm.
- Bàn trà thấp cần chỗ ngồi phù hợp, không giữ ghế ăn cao chỉ vì có sẵn. Dùng kiểu ghế được nguồn hiện tại hỗ trợ; không áp ghế gỗ cong/mặt đan của một mẫu cho mọi sản phẩm. Không tự thêm số chỗ ngồi hoặc đổi toàn phòng.
- Giữ chân ghế, thanh nối và phần đỡ nhìn thấy liền mạch, hợp phối cảnh và tiếp xúc sàn. Không để sót đồ cũ giao nhau với sản phẩm mới.
- Màu sản phẩm chưa hòa với phòng mặc định cần chỉnh ánh sáng cục bộ, phơi sáng, cân bằng trắng và bóng; giữ màu vật liệu, lớp hoàn thiện và vân. Không đổi màu gỗ cho giống tủ/ghế hoặc làm nhạt vân, trừ khi người dùng yêu cầu đổi màu rõ ràng.

## 4. Logo và chữ

- Mọi AI tạo ảnh (Codex, Claude (Flow)) cùng một quy tắc: sản phẩm hiện không tên thương hiệu, không logo; không thêm nhãn, watermark hay chữ vào ảnh; giữ hình in, hoa văn và màu của chính sản phẩm. Không thay logo bằng tên giả (Google Flow từ chối prompt xoá watermark hay đổi thương hiệu).
- Ảnh Flow có dấu sao 4 cánh của Google ở góc dưới phải; không nhờ AI xoá. Khi Claude (Flow) đăng ký ảnh (`src/agent.ps1 register-image`), `Remove-ReviewImageSparkle` (`src/image/unsparkle.ps1` + `unsparkle.mjs`, Node thuần, bộ đọc/ghi PNG riêng `png.mjs`) gỡ lớp phủ trắng bằng phép trừ (không vá), ảnh gốc chưa gỡ lưu ở `logs/<id>-flow-original.png`. Ảnh không có dấu sao hoặc gỡ lỗi thì giao nguyên ảnh. Codex không có dấu sao nên không chạy bước này. Test: `tests/unsparkle.test.mjs` (qua `tests/unsparkle.ps1`).
- Ảnh sản phẩm là căn cứ duy nhất cho màu, dáng và cấu tạo; mô tả chữ của bước nhận diện chỉ là ghi chú, khác ảnh thì theo ảnh.
- Phân loại theo loại sản phẩm trước khi tạo ảnh. Sản phẩm không có chữ theo yêu cầu (áo, nội thất, cốc, tranh có hình cố định) giữ nguyên hình in và chữ của nó. Sản phẩm có chữ theo yêu cầu khách (biển neon tên/logo/quán, bảng tên, biển cưới) thì ảnh sản phẩm thường mang chữ mẫu ("Your Name", "Your Names", "YOUR LOGO", "Your Shop Name", "YOUR GYM NAME"): chữ mẫu đó phải được thay hoàn toàn, không để lọt vào ảnh kết quả. Từ cố định của thiết kế (DJ, Karaoke, Bar, Sweet 16, OPEN 24/7, BEER) và tên đã là nội dung thật (ví dụ tên chú chó trong ảnh tranh thú cưng) giữ nguyên.
- Chữ trên biển không nhập tay: bước phân loại (`Get-ProductContextPrompt`) trả thêm `lettered` (true khi ảnh sản phẩm có chữ mẫu như Your Name / YOUR LOGO; false khi chữ cố định như BEER, DJ, OPEN) và `sample_text` (chữ mẫu đúng như ảnh, ` | ` là xuống dòng). `sign_text` (cột CSV / `Set-ManualSignText`) vẫn là ghi đè, UI không có ô nhập.
- Claude (Flow) chọn CHỮ CHÍNH XÁC trước khi tạo ảnh (cách của social-autopilot, 2026-11-23): Claude đã nhìn ảnh 1 (cảnh) và ảnh 2 (sản phẩm) nên chính Claude chọn chữ, không giao cho Flow. Luật chọn chữ nằm một chỗ: `prompts/sign-choice.txt` (hợp nơi/dịp ở ảnh 1: gym → tên phòng gym, đám cưới → hai tên hoặc "Mr & Mrs", phòng bé → tên bé, bar/garage → tên hợp cảnh; tiếng Anh ngắn đúng chính tả; cùng số dòng với mẫu; tối đa 3 từ mỗi dòng; không tên thương hiệu/quán/người nổi tiếng thật; không chữ giữ chỗ; không trùng chữ của mục khác cùng lượt). Thứ tự: `context` → `sign-brief` → `set-sign-text -Text -Reason` (CLI kiểm tra rỗng, ASCII, số dòng, số từ, chữ giữ chỗ/chữ mẫu, trùng mục khác; lưu `sign_text` + `sign_reason` vào `agent-items.json`, log `logs/<id>-sign-text.json`) → `flow-brief` (thiếu chữ = `NEEDS_SIGN_TEXT`, không tự rơi về chữ do Flow chọn) → ảnh → `register-image -SignRead "<chữ đọc được trên ảnh>"` (phải khớp `sign_text`, không phân biệt hoa/thường, khoảng trắng; lệch = làm lại tối đa 2 lần, lần 3 là lỗi `[CAUSE:SIGN_TEXT]`). Lệnh chi tiết: RUNBOOK.md bước 2-3.
- Có `sign_text` thì prompt dùng mẫu `prompts/sign-wording.txt` (chỗ giữ chỗ `{{OVERRIDES}}`, `{{PRODUCT_IMAGE}}`, `{{LINE_COUNT}}`, `{{LINES}}`, điền bằng `Get-SignWordingRule` trong `src/domain/sign-wording.ps1`; Codex và Claude (Flow) dùng chung, sửa quy tắc chỉ sửa file mẫu). Trong `condensed_prompt` của Flow, dòng SIGN WORDING đứng ngay sau dòng sản phẩm (trước "Key details"), và chữ mẫu bị gỡ khỏi tên/chi tiết sản phẩm (`Remove-SampleLettering`: "customer lettering (see SIGN WORDING)") để không mâu thuẫn với "copy every detail exactly".
- Mẫu tự động `prompts/sign-wording-auto.txt` (AI tạo ảnh tự chọn chữ) chỉ còn cho đường không nhìn được ảnh: Codex/Antigravity, và các lượt Claude (Flow) tạo trước khi có chữ chính xác (thư mục lượt không có `agent-run.json` `{"sign_wording":"exact"}`; `prepare` ghi file này khi tạo danh sách mục của lượt mới). `Get-ItemSignRule` chọn luật. Chuẩn bị trước (`docs/prep-prompt.md`, `prepared.csv`) không chọn chữ: chữ được chọn ở bước Flow, khi Claude nhìn cảnh thật.
- Chữ thay thế đặt ở `sign_text` của từng ảnh bối cảnh trong `references.json` (toàn bộ chữ trên biển, từ trên xuống, ` | ` là xuống dòng; không điền thì giữ quy tắc không thêm chữ). Mọi đường tạo ảnh phải đọc `sign_text`: Codex (`02-create-image.ps1`) và Claude (Flow) (`agent.ps1`: `prepare` lưu `sign_text` vào `agent-items.json`, `flow-brief` thêm đoạn SIGN WORDING vào `condensed_prompt`). Thêm đường tạo ảnh mới thì phải nối `sign_text` ngay; một đường bỏ qua nó sẽ cho ra ảnh giữ chữ mẫu mà log vẫn báo thành công. Sau khi chạy, xem ảnh thật để đối chiếu chữ với `sign_text` (chữ nhỏ cần xem ảnh lớn), không chỉ tin log.
- Chọn chữ thay thế theo quy tắc của skill thương hiệu (ví dụ DreamyVows: tên cặp đôi cho biển cưới và phòng ngủ, tên quán nghe thật cho biển kinh doanh, không dùng thương hiệu có thật). Quy tắc nội dung thuộc về skill thương hiệu, không viết vào tool.

## 5. Giao diện và kho ảnh

- Danh sách bên trái, nút thao tác bên phải, Bắt đầu/Dừng bên dưới. Thêm/sửa trong popup; lưu xong mỗi sản phẩm một dòng nhỏ có thumbnail/trạng thái, bấm để xem lại đúng link/ảnh. Hạn chế chữ đậm, hỗ trợ danh sách lớn.
- Khi chạy, giữ nguyên nhãn các nút và chỉ đổi trạng thái enabled/disabled; hiệu ứng chạy chỉ xuất hiện ở dòng trạng thái bên phải. Nút Dừng vẫn dùng được để hủy lượt đang chạy.
- Màn duyệt kết quả hiển thị mỗi đánh giá một dòng, kể cả cùng sản phẩm. Giữ/Bỏ chỉ tác động dòng đó; bấm thumbnail xem ảnh lớn và ảnh gốc đối chiếu. CSV cuối chỉ gồm các đánh giá được giữ. Không gộp mảng kết quả thành một mục khi đọc JSON trên Windows PowerShell.
- Dán clipboard, chọn file hoặc kéo thả ảnh cho từng URL. Đổi URL không mang ảnh cũ sang. Hủy popup không thay dữ liệu. Lưu snapshot/hash; không dùng ảnh của URL khác hoặc âm thầm thay ảnh chỉ định bằng ảnh trong kho.
- Lượt Claude (Flow): `flow-brief` phải đặt `ActiveScene` = ảnh review của CHÍNH item (`review_photo`/`review_sha256` trong `agent-items.json`); để `$null` thì `Get-ReviewPhoto` lấy cảnh ĐẦU của link và hai item của một link ra cùng một căn phòng (lượt agent-20261119022917: refs/004 lưu cảnh 1 dù agent-items ghi cảnh 2).
- Khi chạy song song hoặc phục hồi, gắn đường dẫn, file ảnh và kết quả với đúng ItemId và snapshot của lượt đó; không nhận hoặc chép ảnh từ lượt khác. Nếu hai sản phẩm khác nhau có cùng hash ảnh xuất, báo nghi vấn và giữ lại để kiểm tra, không đánh dấu hoàn tất; hash trùng là bằng chứng ảnh giống nhau, chưa xác định nguyên nhân lẫn file.
- Hai đầu vào riêng: ảnh sản phẩm gốc quyết định thiết kế; ảnh bối cảnh quyết định người/phòng cần chỉnh. Web chưa public vẫn dùng ảnh gốc trực tiếp; có đủ ảnh thì không cần link thật. Khi thiếu/hỏng ảnh đã chỉ định phải báo lỗi, không âm thầm tải web hoặc đổi ảnh khác.
- “Một ảnh = một sản phẩm” nói về ảnh review: mỗi ảnh review tạo một kết quả riêng, dùng cùng ảnh sản phẩm gốc của URL đó. Không gộp hai ảnh review trong một lượt, không bỏ ô ảnh sản phẩm gốc hoặc coi ảnh review là ảnh gốc. Mỗi lượt mới dùng một ảnh review và một ảnh sản phẩm gốc; không thêm ảnh phong cách thứ ba.
- Ảnh review cung cấp cách trình bày, người và bối cảnh đang có. Nếu ảnh review chỉ có áo gấp/đặt trên bàn, giữ cách trình bày đó, không yêu cầu thêm ảnh người hoặc tự bịa người mẫu. Áo gốc chụp phẳng/gấp vẫn thuộc luồng quần áo, không phân loại thành đồ nội thất hoặc ép ảnh review phải có bàn.
- Ảnh người dùng gắn được dùng trực tiếp, không chặn vì kích thước tối thiểu hay chấm chất lượng/độ phù hợp. Không thêm lại thông báo “Reference image is too small” hoặc bước xét ảnh trước khi tạo. Giữ đúng cặp ảnh đã chọn và hash đầu vào.
- Kho dùng tên tiếng Việt có dấu theo nhóm hàng chung như `Áo`, `Nội thất`; không chia theo website, không gọi kho áo là kho cả quần áo. Giữ nhóm khác để dùng về sau. `source_group` là nhóm thư mục; `category` là mã danh mục chi tiết để chọn ảnh và áp dụng bài học.
- Chuyển kho phải cập nhật đường dẫn, giữ nguồn, hash và lịch sử sử dụng. Kiểm tra inventory thực tế trong catalog, không coi số đếm trong tài liệu là luôn cập nhật.
- App không tự chọn hay chấm ảnh review (đã bỏ chọn ảnh từ kho, kiểm tra FIT/NOFIT và missing-data). Link chưa gắn ảnh review dừng với `[CAUSE:PRODUCT_INPUT]`. Không kéo dài sản phẩm để lấp đồ cũ.
- Ảnh review có thể chụp bất cứ gì (phòng, bàn, sàn, xe…). Prompt đồ vật gọi ảnh 1 là ảnh gốc, không phải "căn phòng": khi ảnh review không phải phòng mà ảnh sản phẩm là phòng, AI web (Flow) từng trả lại chính phòng của ảnh sản phẩm.
- Nhận diện sản phẩm chỉ trả tên, cách trưng bày, chi tiết và danh mục; không còn `setting`/`reject`/`subject` (dùng để chọn ảnh kho). Prompt tạo ảnh không mô tả bối cảnh "phù hợp": ảnh review là bối cảnh, mô tả khác dễ mâu thuẫn với nó.
- Dữ liệu bổ sung cần file thật, nguồn, SHA256, kích thước và ghi nhận kiểm tra. Phân biệt gallery khách hàng, ảnh nhà sản xuất và ảnh review; không gắn nhãn Judge.me cho nguồn khác.

## 6. Review mẫu và báo cáo

- Rating mẫu random độc lập từng review: 60% cho 5 sao, 40% cho 4 sao; batch nhỏ không bắt buộc đúng tỉ lệ tuyệt đối.
- Kho tên nam/nữ dùng dạng tên riêng + chữ cái đầu của họ, ví dụ `Josh K.`; mỗi tên riêng một dòng, không nhân từng tên với họ A–Z. Xáo trộn, dùng hết kho trước khi lặp; đây là tên cho dữ liệu mẫu.
- Dùng toàn bộ `review-samples.jsonl` làm một kho cách viết chung, không lọc theo danh mục hoặc phụ thuộc kho ảnh. Mỗi dòng chỉ giữ `body`, bỏ ID, URL nguồn và metadata sản phẩm; chuẩn hóa khoảng trắng, bỏ dòng rỗng và nội dung trùng trên toàn kho. Mỗi review chọn ngẫu nhiên một mẫu để học cách diễn đạt, nhịp và độ dài, lưu lại đúng đoạn mẫu đã dùng.
- Nội dung review phải theo ảnh sản phẩm hiện tại; không lấy đặc điểm sản phẩm, tuyên bố hoặc trải nghiệm từ mẫu. Không áp bộ kiểu viết định sẵn hoặc gợi ý một cụm mở đầu cố định cho mọi review.
- Không viết câu cảm thán, dấu chấm than hoặc thán từ phấn khích, kể cả mẫu tham khảo có dùng; diễn đạt nhận xét bằng câu bình thường.
- Review mẫu viết như bình luận nhanh về điều nhìn thấy; không ép mở đầu bằng chi tiết sản phẩm hoặc lặp khuôn “The…”. Cho phép phản ứng cá nhân, câu cụt, viết thường, dấu câu thoải mái và lỗi chính tả/ngữ pháp nhỏ; không cố rải lỗi hay thay bằng một khuôn mở đầu khác.
- Không bắt buộc hoặc cấm tuyệt đối “I like”, “I love”, “tôi thích”; dùng tự nhiên và đa dạng. Không bịa trải nghiệm mua hàng, giao hàng hay sử dụng. Đây là dữ liệu mẫu được tạo, không phải lời chứng thực khách thật.
- Phân biệt thời gian một lượt AI với tổng thời gian sản phẩm; giữ timeout, tiến độ, số lượt thử và lý do lỗi. Không tắt tiến trình không thuộc lượt workflow.
- Báo riêng code đã sửa, kiểm tra offline, ảnh đã tạo thật và ảnh đã xem đối chiếu. Không dùng mock để khẳng định chất lượng ảnh đã đạt. Ghi bài học không có nghĩa lỗi đã được sửa và kiểm chứng.
- Chỉ nói đã cập nhật Git sau commit/push thành công. Kiểm tra diff, giữ thay đổi đang có và không đưa output tạm vào repository.
- CSV Loox: giữ đúng 8 tên cột theo template tải trực tiếp của Loox, header không có dấu nháy hoặc BOM; xuất UTF-8, ngày `YYYY-MM-DD` và boolean viết hoa. Khi Loox báo lỗi cột, kiểm tra đúng file người dùng đã upload trước khi quy lỗi cho việc chọn nhầm file. Khác biệt định dạng chỉ là giả thuyết cho đến khi import thực tế được xác nhận.
- Bàn giao kho kết quả (GitHub): kiểm tra kết nối trước khi tạo; upload tuần tự và chỉ ghi link HTTPS công khai vào CSV. Upload lỗi không được âm thầm thay bằng đường dẫn local hay đánh dấu hoàn tất. Giữ ảnh, nội dung và snapshot để thử lại upload, không tạo ảnh lại; giữ cả các cảnh đã thành công của cùng URL đến khi toàn bộ URL hoàn tất.

## 7. Cách ghi bài học

- Quy tắc chung ở các mục trên dành cho người/agent sửa dự án. Các bài học theo URL/danh mục mà luồng tạo ảnh đọc nằm trong các mục gạch đầu dòng bên dưới. Không chỉ thêm văn xuôi rồi coi như app đã nhận bài học theo phạm vi.
- Agent phải đúc kết mỗi bài học thành 1–3 gạch đầu dòng ngắn: nguyên tắc cần giữ, điều cần tránh và phạm vi nếu cần. Không bê nguyên lời người dùng, kể lịch sử xử lý hoặc lặp một ý thành đoạn văn dài. Thêm dấu gạch trước bản chép nguyên văn chưa phải đúc kết.
- Viết tiếng Việt, tự đủ nghĩa khi clone source mới. Không yêu cầu ảnh, log hoặc batch cũ trong `workspace` để hiểu bài học; đường dẫn lịch sử chỉ là bằng chứng phụ. Ảnh hiện tại không rõ thì ghi nhận chưa xác minh.
- Giữ `id` khi làm rõ bài học cũ để liên kết bật/tắt còn đúng. Cập nhật mục trùng thay vì chép lặp; lỗi riêng của một mẫu không biến thành thiết kế bắt buộc cho cả danh mục. Không tự biến lời AI thành yêu cầu người dùng.
- Khi cập nhật bài học, agent phải hiểu ngữ cảnh rồi rút ra quy tắc áp dụng lại được; giữ đúng ý người dùng, không tự thêm yêu cầu hay đánh dấu ảnh đã duyệt. Ví dụ “màu chưa hợp” được đúc kết thành “Hòa ánh sáng và bóng cục bộ; giữ màu vật liệu và vân gốc”.

## 8. Vị trí cần đọc khi sửa

- `src/application/agent-lessons.ps1`: đọc khối bài học trong file này.
- `src/application/image-feedback.ps1`: lọc bài học theo URL/danh mục để đưa vào prompt.
- `src/workflow/steps/01-load-inputs.ps1`: ảnh sản phẩm (gắn hoặc tải từ link), nhận diện bằng AI chữ, ảnh review người dùng gắn (kiểm tra file/hash).
- Bố cục chung của mọi prompt (nhận diện, tạo ảnh, viết review): `TASK` rồi các `STEP` đánh số (tạo ảnh: ảnh nền, sản phẩm, đặt vào, giữ nguyên, kết quả; bài học nối thêm ở STEP 6). Thêm quy tắc mới vào đúng STEP hoặc vào bộ quy tắc lõi, không thêm câu rời.
- `src/image/product-rules.ps1` (`Get-ReviewProductRules <chỉ số ảnh sản phẩm>`): bộ quy tắc lõi của Product Review về nguồn, màu, hình dạng, bề mặt, khớp cảnh, giới hạn, tự kiểm; quy tắc 5 (FIT) giữ ảnh nền như có, cả nhiễu. Chỉ Product Review dùng (không còn bản chung ở hub); các khối riêng theo loại (bàn ăn, áo mặc) chỉ thêm cách đặt, không chép lại. Văn bản phải giữ y hệt, test `reference-fallback` kiểm.
- `src/workflow/steps/02-create-image.ps1`, `src/infrastructure/image-output.ps1`: prompt và vai trò ảnh (ảnh 1 review, ảnh 2 sản phẩm), gọi AI ảnh, thử lại khi mất kết nối.
- `src/workflow/steps/03-write-review.ps1`, `data/writing-style.json`: bộ quy tắc review duy nhất, đánh số theo nhãn (CONTENT, OPINION, VOICE, WORDS, STRUCTURE, FACTS, OUTPUT); sửa quy tắc viết review ở đây, không thêm câu rời vào prompt. `src/domain/writing-style.ps1`: kiểm tra bản nháp (dấu chấm than, thán từ, chép mẫu; lần đầu còn kiểm gạch dài, từ bóng bẩy, "not just…but", câu "overall", liệt kê ba ý, các câu cùng độ dài, và độ dài theo mẫu); câu mẫu ngẫu nhiên đưa vào prompt đã bỏ dấu chấm than. Một lần sửa nếu bản đầu vi phạm.
- `src/workflow/steps/04-complete-metadata.ps1`, `05-export-results.ps1`: sao, tên, email, ngày; lưu kết quả và hàng đợi URL.
- `src/application/batch-review.ps1`: kết quả từng lần chạy (`results.json`) và quyết định Giữ/Bỏ (`review.json`).
- `src/application/loox-export.ps1`: nơi duy nhất ghi file Loox. Mỗi lần xuất (một hay nhiều lần chạy, chọn trong Duyệt) ra **một file CSV** `workspace/exports/loox_<giờ>.csv`, đặt tên theo giờ, nằm thẳng trong `exports`, không thư mục con và không file tổng hợp; đó là file nạp vào Loox. Mỗi lần chạy đã xuất có `<lần chạy>/exported.txt` ghi đường dẫn file đó để Duyệt hiện "đã xuất". Chỉ xuất khi mọi ảnh đều đã có quyết định. Lần chạy bị dừng giữa chừng chưa có sao, tên và ngày (bước 4 chỉ chạy lúc cuối): khi xuất, các dòng đã Giữ được điền bằng đúng quy tắc bước 4 và lưu lại vào `results.json`.
- `workspace/output/<lần chạy>/` (ảnh, `results.json`, `review.json`, log của riêng lần chạy đó) và `workspace/exports/` (các file Loox đã xuất) là hai nơi tách nhau. Nút "Mở kết quả" mở thẳng `exports`.
- `workspace/config/run-settings.json`: lưu Luồng, Viết review và Tạo ảnh. Không có Kiểu chạy, không tự sinh thêm review. Ở Duyệt, từng dòng có Giữ (cả ảnh), Chỉ lấy nội dung (`review.json` quyết định `text`) và Bỏ. Xuất Loox giữ nội dung/sao/tên/ngày của dòng `text`, chỉ để `photo_url` rỗng trên bản xuất; giữ nguyên ảnh/link và kết quả gốc để đối chiếu hoặc đổi quyết định.
- `src/application/reference-archive.ps1`: snapshot, nguồn và hash đầu vào.
- `src/infrastructure/ai.ps1` (`Invoke-AI`, nối cấu hình của tool với lõi chung `core/ai`): chỉ còn Codex, Antigravity CLI và Claude CLI. Gemini web, Grok/ChatGPT web, bridge (cổng 8775) và extension Chrome "Product Review" đã GỠ HẲN (`core/bridge/`, `core/extension/`, `core/ai/providers/browser.ps1`); cấu hình đã lưu chọn Gemini (`textBackend`) tự về Codex. Ô Viết review: Codex, Antigravity CLI, Claude (`-TextBackend codex|antigravity|claude`); ô Tạo ảnh: Codex (mặc định) và Claude (Flow) (agent mode, Chrome riêng). Claude viết review (ô Viết review) qua provider text `core/ai/providers/claude.ps1`: `claude -p --output-format json`, chỉ công cụ Read (`--tools Read`, không Bash/Write/web), không MCP (`--strict-mcp-config`, không `--mcp-config`), `--no-session-persistence`; ảnh review chép vào thư mục tạm riêng và đường dẫn ghi trong prompt để Claude tự Read; tìm CLI qua `PR_CLAUDE_CLI` hoặc PATH (như agent mode); token lấy từ `usage` của JSON vào `ai-usage.jsonl`; lỗi ánh xạ [CAUSE:AUTH|QUOTA|BUSY|NETWORK|AI_TIMEOUT]. Agent mode (Claude + Flow) vẫn là đường riêng cho Tạo ảnh. Không dùng API key. Antigravity (`agy`, `core/ai/providers/antigravity.ps1`): prompt và ảnh vào một thư mục riêng vì agy chỉ nhận prompt qua `-p`. Không tự đổi AI: chạy lỗi với AI khác thì hỏi người dùng có chạy lại bằng Codex không.
- Claude (Flow) điều khiển trình duyệt bằng Playwright MCP, hai chế độ chọn ở ô trình duyệt của thẻ Thao tác (lưu `workspace/config/flow-browser.json`, `core/setup/flow-browser.mjs`): (a) MẶC ĐỊNH Chrome THẬT của người dùng qua extension Playwright MCP Bridge (`--extension --profile-dir-name <profile>`): profile chọn từ danh sách có trên máy (Local State); profile chưa có extension thì `POST /api/agent/run` và mọi lượt quét/đếm review từ chối (`checkExtensionProfile`), có nút "Cài extension vào profile này" chỉ MỞ trang Chrome Web Store trong đúng profile đó (người dùng tự bấm Thêm), không bao giờ dùng profile khác thay thế; mỗi lượt người dùng bấm Connect, TRỪ KHI profile đó đã gắn token Playwright (tùy chọn, ô "Token Playwright (tùy chọn)" dưới ô Chrome profile ở thẻ Thao tác, chỉ hiện ở chế độ extension với profile đã có extension): token lưu ở file DÙNG CHUNG `workspace/playwright-tokens.json` theo thư mục profile (mỗi profile một token, regex `[A-Za-z0-9_.-]{8,200}`, ghi nguyên tử, `core/setup/flow-browser.mjs` `extensionToken | tokenProfiles | saveExtensionToken`), chỉ truyền qua env `PLAYWRIGHT_MCP_EXTENSION_TOKEN` của tiến trình `claude` (không ghi vào file mcp-config tạm, không log, không trả về trang; `/api/flow-browser` chỉ trả `token_saved`, `POST /api/flow-browser/token` lưu / xoá), extension tự kết nối và lời nhắc agent nói không cần chờ Connect; không gắn token thì mọi thứ như cũ; ô chỉ lưu khi người dùng thật sự đổi giá trị. (b) Chrome RIÊNG `workspace/chrome-profile/` (`--browser chrome --user-data-dir`; mặc định hiện cửa sổ, `PR_FLOW_HEADLESS=1` chạy ngầm; Google Flow từng chặn "hoạt động bất thường" khi chạy ngầm), chỉ một phiên dùng cùng lúc. `core/setup/agent-run.mjs`: mỗi lượt `claude -p` nhận một mcp-config JSON tạm (`workspace/tmp`, xoá khi xong), không sửa cấu hình MCP toàn cục. `core/setup/flow-login.mjs`: `GET /api/flow-login/status` ({state: logged_in|logged_out|busy|error, detail}; một Chrome headless ngắn mở https://flow.google.com trên profile, bị chuyển sang accounts.google.com = chưa đăng nhập, cần thêm cookie phiên Google còn hạn; profile đang mở hoặc đang có run = `busy`, không đóng Chrome đó) và `POST /api/flow-login/open` (mở Chrome THƯỜNG, không cờ tự động hoá, để người dùng tự đăng nhập; từ chối khi đang có run). Không bao giờ nhập hay lưu thông tin đăng nhập hộ người dùng. `POST /api/agent/run` từ chối khi chưa đăng nhập. UI (tab Tạo ảnh, chọn Claude (Flow)): khối "Đăng nhập Google Flow" ở thẻ Thao tác (trạng thái, Mở Chrome để đăng nhập, Kiểm tra lại); chưa đăng nhập thì khoá Bắt đầu. Đường dẫn Chrome: `PR_CHROME_PATH` hoặc vị trí cài mặc định. `flow-brief` (`src/agent.ps1`) rút gọn mô tả sản phẩm ở ranh giới câu, không cắt giữa từ.
- Ngoại lệ Google Flow (2026-11-23): lượt tạo ảnh Flow KHÔNG chạy nền; tab Flow được đưa lên trước mỗi lần tải ảnh lên / gửi prompt / tải ảnh về, vì Google gắn cờ "unusual activity" khi thao tác trong tab ẩn (`mcpConfig` extension.background = false cho mode flow).
- Không bao giờ giành focus (trừ bước Flow ở trên): chế độ Chrome hằng ngày (extension) chạy Playwright MCP ở chế độ nền (`PLAYWRIGHT_MCP_BACKGROUND=1`, tức `--background`) (`bringToFront` / chọn tab thành no-op, tab mới mở không kích hoạt, sau Connect không focus cửa sổ). Prompt cấm agent đưa Chrome lên trước / kích hoạt tab hay cửa sổ; tab chạy nền (ẩn là bình thường): chờ ở phía Node, cuộn bằng scrollBy, click "not stable" thì `force: true`. Cửa sổ Chrome do tool mở dùng `WINDOW_ARGS` (`core/setup/flow-login.mjs`: 1280x800 tại 80,60; không nhỏ hơn ~1024x700 để web không chuyển sang giao diện mobile).
- KIỂM TOÁN nhiều phiên chạy cùng lúc (không bao giờ ghi đè / trộn dữ liệu của nhau). Mỗi mục dùng chung hoặc riêng và quy tắc:
  - RIÊNG MỖI PHIÊN (`workspace-sessions/<tên>/`, phiên mặc định = `workspace/`): hàng chờ `urls.txt` + `reference-inputs/`, `output/`, `temp/`, `tmp/`, `rejected/`, `exports/`, `delivery-pending/`, `logs/`, `runs/`, `webview2/data`; và các file cấu hình `config/flow-browser.json` (chế độ + profile Chrome) và `config/run-settings.json` (ô chọn, Luồng, Viết review/Tạo ảnh, tài khoản Flow): phiên mới được tạo từ bản của phiên mặc định lần đầu đọc (`readSeededJson`), rồi đi riêng; ghi bằng `updateJsonLocked` (khoá + đọc-sửa-ghi + file tạm rồi đổi tên).
  - DÙNG CHUNG + KHOÁ: `config/sessions.json` (sổ phiên: khoá + gộp + ghi nguyên tử, pid chết bị loại), `config/locks/*` (mỗi file một khoá; khoá của pid chết bỏ qua), `config/recent-projects.json` (khoá), `ai-model.json` / `ai-accounts.json` (ghi nguyên tử `Write-FileAtomic`), `source-photos/` (thư viện ảnh: ghi file tạm rồi đổi tên; `.sync.json`, `phash.json` ghi nguyên tử, `phash.json` gộp khi lưu dưới khoá), log dùng AI (chỉ nối thêm một dòng).
  - DỰ ÁN `workspace/projects/<id>/` (dùng chung, mỗi dự án MỘT khoá file `.project.lock` bằng khoá hệ điều hành nên tiến trình chết không bao giờ làm kẹt): `products.csv` (cờ `used`, số review, thêm sản phẩm), `reviews.json`, `menu.json`, `project.json` đều đọc-sửa-ghi LẠI BÊN TRONG khoá, chỉ đổi dòng bị động tới, ghi qua file tạm + đổi tên; `prepared.csv` có khoá riêng `prepared.csv.lock`. Lượt chạy trên dự án vẫn giữ khoá dự án theo phiên (từ chối khi phiên sống khác đang dùng).
  - THƯ MỤC DOWNLOADS dùng chung của máy: agent giữ khoá tải máy-rộng quanh MỖI lần tải: `node core/flow-pace.mjs download-lock acquire --tag <id>` ... `release` (chờ đến khi rảnh, quá 5 phút coi là cũ), chuyển/đổi tên file mới vào thư mục riêng của phiên ngay và kiểm kích thước / ô prompt.
  - `core/flow-pace.mjs` (nhịp gửi prompt Flow, `workspace/tmp/flow-pace.json`) CỐ Ý dùng chung mọi phiên để giới hạn tốc độ của Flow tính chung; hai `gate` cùng lúc không tranh chấp: đọc-sửa-ghi dưới khoá file O_EXCL, ngủ NGOÀI khoá, ghi nguyên tử.
  - Mã lượt chạy (`newRunId`) có hậu tố ngẫu nhiên; thư mục kết quả và log nằm trong thư mục phiên nên hai phiên bắt đầu cùng giây không đụng nhau; file chép sang Downloads mang mã lượt.
- Chuẩn bị trước (`docs/prep-prompt.md`, mode `prep`) + hàng chờ tức thì: `src/scan.ps1 prep-todo | prep-add | prep-status | queue-from-prepared`; kho `workspace/projects/<id>/prepared.csv` (dùng chung mọi phiên, ghi dưới khoá file `prepared.csv.lock`). `Thêm vào hàng chờ` lấy trước các dòng `ready` bằng `queue-from-prepared` (không agent, kiểm lại file/sha256/trùng cảnh, dòng hỏng bị bỏ về "chưa chuẩn bị"), chỉ phần thiếu mới chạy agent. Lượt prep và queue chạy trên runner NHẸ (`kind: "light"` trong `core/setup/agent-run.mjs`, trạng thái `workspace/runs/prep-run.json`, KHÔNG Playwright MCP, KHÔNG Chrome) nên chạy song song với Bắt đầu; hai lượt nhẹ cùng lúc bị từ chối. Mọi ghi vào hàng chờ (`Add-QueueEntry`, `Save-ManualMapEntry`, `Remove-FromQueue`) đi qua `Use-QueueMutex` (một mutex mỗi workspace phiên), nên batch đang chạy, app và `queue-from-prepared` không làm mất mục của nhau.
- Tăng tốc chọn ảnh bối cảnh (2026-11-21; trước đó một lượt prep trên dreamyvows-com mất 9+ phút, 60+ lượt trước khi lưu được sản phẩm đầu vì Claude Read từng ảnh cảnh, ≥ 6 ảnh mỗi sản phẩm): (1) KHO NHÃN `workspace/source-photos/scene-index.json` (dùng chung mọi dự án và phiên, chỉ `scan.ps1 scene-index-add` / `scene-index-todo` ghi, dưới khoá `scene-index.json.lock`, ghi nguyên tử): mỗi ảnh kho có group, name, category, md5, sha256, phash (CLI tính) và nhãn Claude viết sau khi xem ảnh MỘT lần: setting, people, light (day/night/warm), wall_space, fits (loại sản phẩm hợp), note, usable; ảnh trùng hình với ảnh đã có nhãn ghi `dup_of`; md5 đổi = coi như chưa gắn nhãn. Lượt "Gắn nhãn kho ảnh" (`docs/index-prompt.md`, mode `index` trên runner NHẸ, khoá máy `library/scene-index`, nút trong popup Dự án). (2) ẢNH GHÉP `src/infrastructure/contact-sheet.ps1` (`contact-sheet`, tối đa 24 ảnh ~300 px một tấm, số to trên từng ô, chú giải số -> tên): Claude Read MỘT tấm thay vì 12-20 file. (3) DANH SÁCH THEO NHÓM: `prep-todo` / `queue-todo -Grouped -Sheet` (nhóm theo collection, không có thì theo từ loại trong tiêu đề, khúc 20, mỗi nhóm một tấm ảnh sản phẩm) và `scene-candidates -Fits "<loại>" [-Setting] [-Group] -Limit` (ảnh đã gắn nhãn, chưa dùng, không trùng, xếp theo độ khớp nhãn, kèm tấm ghép đánh số). Nhãn chỉ THU HẸP danh sách: Claude vẫn tự xem tấm ghép và quyết định hợp hay không; không đoạn mã nào chọn cảnh. Mọi kiểm tra cũ giữ nguyên (SCENE_DUPLICATE, SCENE_REUSED, sha256, trạng thái prepared.csv, khoá). Không thêm trình duyệt vào prep/queue/index; nhịp gửi prompt Flow (`core/flow-pace.mjs`) không đổi.
- Tiêu điểm dự án (`initFocus` trong `src/mac/server.mjs`, `claimProjectFocus` trong `core/setup/session.mjs`): MỖI cửa sổ luôn có MỘT dự án đang chọn (trường `project` của sổ phiên, lưu ở `config/focus.json` của phiên) hoặc "Lẻ (không thuộc dự án)" cho sản phẩm gõ tay (không bao giờ là mặc định). Lúc khởi động: phiên mở theo dự án giữ dự án đó; ngược lại dự án đã lưu nếu còn tồn tại và rảnh; không thì dự án dùng gần nhất (`recent-projects.json`) đang rảnh; không thì dự án rảnh đầu tiên (nhiều sản phẩm chưa dùng nhất); không có dự án nào = Lẻ. Đổi tiêu điểm (`POST /api/session/project`, `__loose` = Lẻ) là một bước nguyên tử dưới khoá sổ phiên (thả dự án cũ, lấy dự án mới), bị từ chối khi dự án đang dùng ở cửa sổ khác, khi cửa sổ có lượt chạy, hoặc khi cửa sổ khoá theo dự án. Mọi route dự án (queue, prep, reviews, prepared) từ chối id khác với tiêu điểm (`focusMismatch`). Tiêu đề cửa sổ: `Product Review · #stt · <tên dự án hoặc phiên> · <email (Profile)>`.
- Cửa sổ mở theo dự án: "Các phiên" > chọn dự án có sẵn (hoặc "Khác: tên tự đặt") mở một phiên tên = id dự án, cửa sổ đó chọn sẵn dự án trong popup Dự án; dự án mà phiên sống khác đang chọn (`sessions.json` trường `project`) hoặc đang chạy (khoá) bị làm mờ / từ chối.
- Phiên (nhiều cửa sổ từ MỘT source, `core/setup/session.mjs`, `core/setup/session-env.mjs`): phiên mặc định dùng `workspace/` như cũ; phiên khác `start-app.cmd <tên>` / `start-app.command <tên>` / nút "Mở cửa sổ mới" trong app (tên `[a-z0-9-]`, tối đa 30) dùng `workspace-sessions/<tên>/` (Git bỏ qua). Mỗi phiên: cổng riêng (băm thư mục + tên phiên), cửa sổ riêng, một agent, và RIÊNG hàng chờ (`urls.txt`, `reference-inputs/`), `output/`, `temp/`, `rejected/`, `exports/`, `logs/`, `runs/`, `tmp/`, `webview2/data`. DÙNG CHUNG (luôn là `workspace/` của bản cài): `config/`, `projects/`, `source-photos/`, `chrome-profile/`, log dùng AI, sổ phiên `config/sessions.json` (stt = số trống nhỏ nhất trong các phiên đang sống, giữ đến khi cửa sổ đóng) và khoá `config/locks/` (một dự án hoặc Chrome riêng chỉ một phiên sống dùng một lúc; khoá của pid đã chết bị bỏ qua). Mã dùng `Get-SessionWorkspaceDir` (PowerShell) / `sessionWorkspace()` (Node); đường dẫn dùng chung vẫn viết literal `workspace/...`. Tiêu đề cửa sổ và huy hiệu ở đầu app: `Product Review · #<stt> · <phiên> · <profile Chrome>`; nhóm tab Chrome của mỗi lượt: `Product Review · <phiên> · #<n> · HH:mm` (n = bộ đếm của phiên, màu xoay vòng), đầu lượt agent chỉ đóng tab thuộc nhóm CŨ của cùng phiên. Mở lại cùng một phiên chỉ đưa cửa sổ cũ lên trước. `core/flow-pace.mjs` cố ý dùng chung giữa các phiên để nhịp gửi prompt Flow tính chung.
- `tests/run.ps1`: chạy suite liên quan bằng Windows PowerShell khi được phép.
- `workspace/output/`: kết quả và log cục bộ, Git bỏ qua.

<!-- app-lessons:start -->
## Bài học đã đúc kết

Bài học được đúc kết thành nguyên tắc ngắn để áp dụng lần sau, không chép lời phản hồi hoặc kể lịch sử xử lý. Chỉ áp dụng đúng URL/danh mục; yêu cầu mới nhất của người dùng có ưu tiên cao nhất. Comment giữ mã và phạm vi để app đọc, bật/tắt bài học.

### Giữ cấu tạo ghế đầy đủ
<!-- app-lesson: {"id":"2b459eefc9514ffa999909bbc85d42ea","scope":"product","product_url":"https://bangometay.com/p/ban-go-tu-nhien-chan-tang-nguyen-khoi-tu-nhien-2m8x85x6-5cm/","category":"dining-tables","created_at":"2026-10-26T07:04:24.644366Z"} -->
Áp dụng: https://bangometay.com/p/ban-go-tu-nhien-chan-tang-nguyen-khoi-tu-nhien-2m8x85x6-5cm/.

- Giữ chân ghế, thanh nối, lưng và mặt ghế nhìn thấy liền mạch, đúng phối cảnh và tiếp xúc sàn.
- Không để chân bị cụt, đứt hoặc xuyên đồ vật; không đoán phần bị che.

### Đồng bộ bàn và ghế theo nguồn
<!-- app-lesson: {"id":"f84798614e0d45a1a9d46ec91a0b33ca","scope":"product","product_url":"https://bangometay.com/p/ban-go-tu-nhien-chan-tang-nguyen-khoi-tu-nhien-2m8x85x6-5cm/","category":"dining-tables","created_at":"2026-10-26T07:12:01.185526Z"} -->
Áp dụng: https://bangometay.com/p/ban-go-tu-nhien-chan-tang-nguyen-khoi-tu-nhien-2m8x85x6-5cm/.

- Bộ bàn ghế phải giữ đúng thiết kế cả bộ; không chỉ thay bàn rồi giữ ghế sai kiểu.
- Nếu chỉ bán bàn, phối các ghế hiện có theo yêu cầu; không tự thêm ghế hoặc coi ghế là hàng bán kèm.

### Hòa ánh sáng, giữ màu vật liệu
<!-- app-lesson: {"id":"7aeb3fcd590741439c8b449ca7d36cc3","scope":"product","product_url":"https://bangometay.com/p/ban-go-tu-nhien-chan-tang-nguyen-khoi-tu-nhien-2m8x85x6-5cm/","category":"dining-tables","created_at":"2026-10-26T07:36:05.4286701Z"} -->
Áp dụng: https://bangometay.com/p/ban-go-tu-nhien-chan-tang-nguyen-khoi-tu-nhien-2m8x85x6-5cm/.

- Sản phẩm chưa hòa với phòng: chỉnh ánh sáng cục bộ, cân bằng trắng và bóng tiếp xúc.
- Giữ màu vật liệu, lớp hoàn thiện và vân; chỉ đổi màu vật liệu khi người dùng yêu cầu rõ.

### Ghế cho bàn ăn
<!-- app-lesson: {"id":"table-seating-dining-tables","scope":"category","product_url":"","category":"dining-tables","created_at":"2026-10-27T06:48:09.3468036Z"} -->
Áp dụng: danh mục `dining-tables`.

- Ghế quanh bàn ăn phải hợp phong cách và chiều cao sử dụng; bán cả bộ thì dùng đúng ghế của bộ. Mặt bàn là mặt phẳng cứng ngang theo sàn: không chúi về người xem hoặc lệch ngang về một hàng ghế; cạnh vẫn thu theo phối cảnh, không ép ngang khung ảnh. Giữ tỉ lệ, độ dày và chân theo nguồn, không kế thừa chân bàn cũ.
- Chỉ bán bàn thì phối ghế hiện có theo yêu cầu, không coi ghế là hàng bán kèm. Khoảng từ MẶT ĐỆM GHẾ đến MẶT DƯỚI BÀN phải thoáng rõ, đủ để đùi, đầu gối và chân; không tính khoảng hở tới mặt trên hoặc che chỗ chật bằng mép bàn.
- Cho phép chỉnh cục bộ vị trí và tỉ lệ toàn ghế khi cần, giữ kiểu ghế, số chỗ ngồi và chân chạm sàn. Không bóp thấp/kéo giãn bàn, tăng độ dày mặt hoặc đổi chân để khớp ghế; không bịa kích thước, thêm ghế hay đổi kiến trúc phòng.

### Chỗ ngồi cho bàn trà
<!-- app-lesson: {"id":"table-seating-coffee-table","scope":"category","product_url":"","category":"coffee-table","created_at":"2026-10-27T06:48:09.3592337Z"} -->
Áp dụng: danh mục `coffee-table`.

- Bàn trà thấp cần chỗ ngồi phù hợp chiều cao và phong cách; không giữ ghế ăn cao từ phòng mẫu.
- Chỉnh các chỗ ngồi liên quan đang có; không tự thêm ghế hoặc đổi toàn bộ căn phòng.

### Viền cổ mẫu polo xanh phối vai trắng
<!-- app-lesson: {"id":"polo-shoulder-block-collar-edge-20261027","scope":"product","product_url":"https://forteraapparel.com/products/work-polo-shirt-logo-shoulder-block","category":"polo-shirts","created_at":"2026-10-27T16:03:29.9593975+07:00"} -->
Áp dụng: https://forteraapparel.com/products/work-polo-shirt-logo-shoulder-block.

- Viền đúng từ trong ra ngoài: nền xanh navy → một viền trắng → mép ngoài cổ.
- Không thêm dải xanh ngoài viền trắng; giữ vị trí và độ rộng tương đối ở cả hai bên cổ.
- Chỉ áp dụng thiết kế này cho URL chỉ định; đối chiếu ảnh đầu vào hiện tại, không đoán phần không thấy.

### Chú ý chi tiết áo, không chỉ tổng thể
<!-- app-lesson: {"id":"polo-detail-fidelity-20261027","scope":"category","product_url":"","category":"polo-shirts","created_at":"2026-10-27T16:04:20.7937109+07:00"} -->
Áp dụng: danh mục `polo-shirts`.

- Đọc kỹ hình cổ, mép viền, thứ tự màu, số và độ rộng sọc, đường may, nút, nẹp, mảng phối và vị trí logo trước khi tạo.
- Giữ đúng chi tiết của mẫu hiện tại; không thêm bớt, đơn giản hóa hoặc lấy chi tiết áo người mẫu tham khảo.
- Chỉ thay thương hiệu theo quy tắc chung; ghi nhận phần bị che là chưa xác minh.

### Giữ đúng cấu tạo chân và thanh giằng
<!-- app-lesson: {"id":"coffee-table-support-topology","scope":"category","product_url":"","category":"coffee-table","created_at":"2026-10-28T10:45:54.5790622+07:00"} -->
Áp dụng: danh mục `coffee-table`.

- Giữ đúng số lượng, hướng và điểm nối của chân/thanh giằng theo ảnh sản phẩm; không tự thêm nhánh gỗ, thanh chéo hoặc đầu gỗ cụt.
- Thanh giằng phải nối hợp lý giữa các chân; không được chìa ra thành khúc gỗ không có chức năng hoặc giao xuyên nhau.
- Nếu ảnh sản phẩm có dải đỡ cong mảnh, giữ độ dày, đường cong, điểm nối và khoảng trống nhìn thấy; không biến thành khối đặc hoặc lòng chảo. Không lấy cấu tạo từ đồ cũ hay đoán phần bị che.

### Thay áo đang mặc, không đặt thêm áo vào cảnh
<!-- app-lesson: {"id":"polo-replace-worn-garment-no-extra-prop-20261028","scope":"category","product_url":"","category":"polo-shirts","created_at":"2026-10-28T08:28:26Z"} -->
Áp dụng: danh mục `polo-shirts`.

- Thay áo đang mặc bằng áo sản phẩm gốc; nếu nhóm người chính cùng mặc polo thì thay trên từng người, giữ người, tư thế, vật đang cầm và bối cảnh.
- Không giữ áo cũ rồi đặt thêm áo sản phẩm lên xe, ghế hoặc nền; không dán ảnh cắt rời, ô ảnh phụ hay thêm áo làm đạo cụ.
- Ảnh áo gốc chụp phẳng/gấp chỉ cung cấp thiết kế; cách mặc hoặc đặt áo phải theo ảnh review hiện tại.

### Tỉ lệ bàn trà trong phòng
<!-- app-lesson: {"id":"coffee-table-room-scale-proportions-20261029","scope":"category","product_url":"","category":"coffee-table","created_at":"2026-10-29T15:05:52+07:00"} -->
Áp dụng: danh mục `coffee-table`.

- Giữ dáng và tỉ lệ dài, rộng, cao của bàn theo ảnh sản phẩm; đặt bàn đúng phối cảnh, cân đối với ghế và khoảng trống hiện có trong ảnh review.
- Không phóng bàn quá lớn để lấp chỗ hoặc làm bàn ngắn, bè hơn mẫu; không suy ra kích thước thực khi nguồn không cho biết.

### Thay biển neon trong bối cảnh có sẵn - 001-christmas-neon-sign
<!-- app-lesson: {"id":"neon-existing-sign-placement-001-christmas-neon-sign","scope":"product","product_url":"https://dreamyvows.com/products/christmas-neon-sign","category":"","created_at":"2026-11-06T03:00:00Z"} -->
Áp dụng: https://dreamyvows.com/products/christmas-neon-sign.

- Dùng đúng ảnh nền người dùng chọn; thay biển neon cũ và quầng sáng cũ ngay vùng tường của nó, giữ đồ đạc và texture. Toàn bộ chữ, icon và đế phải nằm trong vùng trống, có khoảng hở với tranh, màn hình, kệ, sofa hoặc đầu giường.
- Giữ kiểu chữ, màu và hình gốc; chỉ đổi dòng cá nhân hóa theo yêu cầu hiện tại, không giữ placeholder khi đã được yêu cầu điền tên. Đế trong suốt ôm thiết kế, không thêm bảng chữ nhật đặc hoặc chuyển đạo cụ từ ảnh sản phẩm sang nền.

### Thay biển neon trong bối cảnh có sẵn - 002-neon-light-christmas-decorations
<!-- app-lesson: {"id":"neon-existing-sign-placement-002-neon-light-christmas-decorations","scope":"product","product_url":"https://dreamyvows.com/products/neon-light-christmas-decorations","category":"","created_at":"2026-11-06T03:00:00Z"} -->
Áp dụng: https://dreamyvows.com/products/neon-light-christmas-decorations.

- Dùng đúng ảnh nền người dùng chọn; thay biển neon cũ và quầng sáng cũ ngay vùng tường của nó, giữ đồ đạc và texture. Toàn bộ chữ, icon và đế phải nằm trong vùng trống, có khoảng hở với tranh, màn hình, kệ, sofa hoặc đầu giường.
- Giữ kiểu chữ, màu và hình gốc; chỉ đổi dòng cá nhân hóa theo yêu cầu hiện tại, không giữ placeholder khi đã được yêu cầu điền tên. Đế trong suốt ôm thiết kế, không thêm bảng chữ nhật đặc hoặc chuyển đạo cụ từ ảnh sản phẩm sang nền.

### Thay biển neon trong bối cảnh có sẵn - 003-ho-ho-ho-light-up-sign
<!-- app-lesson: {"id":"neon-existing-sign-placement-003-ho-ho-ho-light-up-sign","scope":"product","product_url":"https://dreamyvows.com/products/ho-ho-ho-light-up-sign","category":"","created_at":"2026-11-06T03:00:00Z"} -->
Áp dụng: https://dreamyvows.com/products/ho-ho-ho-light-up-sign.

- Dùng đúng ảnh nền người dùng chọn; thay biển neon cũ và quầng sáng cũ ngay vùng tường của nó, giữ đồ đạc và texture. Toàn bộ chữ, icon và đế phải nằm trong vùng trống, có khoảng hở với tranh, màn hình, kệ, sofa hoặc đầu giường.
- Giữ kiểu chữ, màu và hình gốc; chỉ đổi dòng cá nhân hóa theo yêu cầu hiện tại, không giữ placeholder khi đã được yêu cầu điền tên. Đế trong suốt ôm thiết kế, không thêm bảng chữ nhật đặc hoặc chuyển đạo cụ từ ảnh sản phẩm sang nền.

### Thay biển neon trong bối cảnh có sẵn - 004-merry-christmas-neon-light
<!-- app-lesson: {"id":"neon-existing-sign-placement-004-merry-christmas-neon-light","scope":"product","product_url":"https://dreamyvows.com/products/merry-christmas-neon-light","category":"","created_at":"2026-11-06T03:00:00Z"} -->
Áp dụng: https://dreamyvows.com/products/merry-christmas-neon-light.

- Dùng đúng ảnh nền người dùng chọn; thay biển neon cũ và quầng sáng cũ ngay vùng tường của nó, giữ đồ đạc và texture. Toàn bộ chữ, icon và đế phải nằm trong vùng trống, có khoảng hở với tranh, màn hình, kệ, sofa hoặc đầu giường.
- Giữ kiểu chữ, màu và hình gốc; chỉ đổi dòng cá nhân hóa theo yêu cầu hiện tại, không giữ placeholder khi đã được yêu cầu điền tên. Đế trong suốt ôm thiết kế, không thêm bảng chữ nhật đặc hoặc chuyển đạo cụ từ ảnh sản phẩm sang nền.

### Thay biển neon trong bối cảnh có sẵn - 005-wedding-neon-sign-neon-sign
<!-- app-lesson: {"id":"neon-existing-sign-placement-005-wedding-neon-sign-neon-sign","scope":"product","product_url":"https://dreamyvows.com/products/wedding-neon-sign-neon-sign","category":"","created_at":"2026-11-06T03:00:00Z"} -->
Áp dụng: https://dreamyvows.com/products/wedding-neon-sign-neon-sign.

- Dùng đúng ảnh nền người dùng chọn; thay biển neon cũ và quầng sáng cũ ngay vùng tường của nó, giữ đồ đạc và texture. Toàn bộ chữ, icon và đế phải nằm trong vùng trống, có khoảng hở với tranh, màn hình, kệ, sofa hoặc đầu giường.
- Giữ kiểu chữ, màu và hình gốc; chỉ đổi dòng cá nhân hóa theo yêu cầu hiện tại, không giữ placeholder khi đã được yêu cầu điền tên. Đế trong suốt ôm thiết kế, không thêm bảng chữ nhật đặc hoặc chuyển đạo cụ từ ảnh sản phẩm sang nền.

<!-- app-lessons:end -->
