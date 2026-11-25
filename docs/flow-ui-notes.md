# Flow UI notes (Vietnamese UI, Playwright MCP) — đọc trước khi mở Flow

Nhãn đúng như UI. Rút từ các lượt chạy thành công (khoảng 40 ảnh/lượt) và lượt chậm (mất 6-10 phút dò UI). Bổ sung bài học mới vào `workspace/flow-ui-lessons.md`.

## Thứ tự nhanh (mục đầu ~3 phút, mỗi mục sau ~2-3 phút)
0. Dự án Flow dùng lại: `node core/flow-pace.mjs project get` (mỗi profile một dự án). Có url thì mở thẳng, cài đặt Hình ảnh / Nano Banana 2.1 / x1 vẫn còn, chỉ kiểm chip và đổi tỉ lệ nếu cần. Chưa có hoặc không mở được thì tạo mới (bước 3-4) rồi `project set --url <url>`. Làm các mục gom theo cùng tỉ lệ.
1. Mỗi lệnh `browser_run_code_unsafe` mở đầu bằng `await page.bringToFront();`. Dùng `getByRole`/`aria-label`, KHÔNG click theo toạ độ chuột, KHÔNG đoán icon.
2. Vào Flow: `browser_navigate` tới `https://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fflow.google.com%2F`, chọn đúng tài khoản của app: `page.locator('[data-identifier="<email>"]').click({force:true})` (click thường hay hết giờ; fallback: `.focus()` rồi `keyboard.press('Enter')`). Xác nhận bằng nút "Thông tin về tài khoản". Không đổi tài khoản.
3. Tạo dự án: nút "Dự án mới" (nếu có lớp phủ `.cdk-overlay-backdrop` thì click nó bằng force trước). URL thành `/project/<id>`. Tên dự án chỉ là tiêu đề, không gõ prompt vào đó.
4. Cài đặt: nút "Điều kiện kích hoạt cài đặt" (cạnh "🍌 Nano Banana 2.1"). Trong `.cdk-overlay-container`: radio "Hình ảnh" (nhóm "Chế độ"), radio tỷ lệ "16:9/4:3/1:1/3:4/9:16" (nhóm "Tỷ lệ khung hình"), radio "x1", model "🍌 Nano Banana 2.1" (nút "Chọn nhóm mô hình"; KHÔNG chọn Pro). Mặc định thường đã là Hình ảnh + x1 + Nano Banana 2.1; chỉ đổi tỷ lệ: `getByRole('radio',{name:'3:4',exact:true}).click({force:true})`, rồi Escape. Kiểm tra nhãn nút (ví dụ "crop_9_16 ... x1") đúng tỷ lệ của mục.
5. Chép 2 ảnh tham chiếu vào `workspace/tmp/flow-uploads/` (trong repo). File chooser của Playwright chỉ cho đọc dưới thư mục repo và `.playwright-mcp`; `C:\Users\Admin\Downloads\...` bị "outside allowed roots". Tên file giữ nguyên (`pr-ref-<run>-<mục>-1.jpg` cảnh, `-2.png` sản phẩm).
6. Tải lên: bấm "Thêm thành phần vào ô nhập câu lệnh" (dấu +) rồi nút "Tải nội dung nghe nhìn lên" (KHÔNG phải tab "Tệp tải lên", đó chỉ là bộ lọc thư viện; click nó không mở hộp thoại). Có file chooser thì `browser_file_upload` với đường dẫn tuyệt đối; hoặc `Promise.all([page.waitForEvent('filechooser'), nút.click()])` rồi `fc.setFiles(path)`. Upload từng file một (cảnh trước, sản phẩm sau) hoặc cả 2 cùng lúc đều được; chờ ~4-6 s.
7. Ảnh vừa tải CHỈ vào thư viện dự án, chưa vào câu lệnh. Gắn lần lượt, CẢNH TRƯỚC, SẢN PHẨM SAU: chuột phải ô `[role=group][aria-label="<tên file>"]` (dùng `click({button:'right',force:true})`, nếu menu không hiện thì `scrollIntoViewIfNeeded()` + `dispatchEvent('contextmenu',{bubbles:true,button:2})`) rồi click chữ "Thêm vào câu lệnh" trong `.cdk-overlay-container`. Cách khác: dấu + > chọn ảnh (`getByRole('option',{name:/tên/})`) > nút "Thêm vào câu lệnh".
8. Kiểm tra đúng 2 chip: `img[alt="Hình ảnh thành phần"]` phải đếm = 2 và `src` chip 1 = ảnh cảnh, chip 2 = ảnh sản phẩm (so với `src` của ô thư viện cùng tên). Sai thứ tự = Flow lấy nền của ảnh sản phẩm (ảnh ra sai cảnh).
9. Gõ prompt vào ô DƯỚI cùng: `getByRole('textbox',{name:'Bạn muốn tạo những gì?'})` (`browser_type` hoặc `.fill(text)`). Không gõ vào ô tên dự án "Văn bản có thể chỉnh sửa". Escape để đóng bảng chọn ảnh trước khi gửi (bảng mở che nút gửi).
10. Gate: `node core/flow-pace.mjs gate --tag <mục>` ngay trước khi gửi. Gửi: nút "Bắt đầu tạo" (`click({force:true})`). Chờ 20-25 s rồi kiểm tra chữ "bất thường|hạn mức|không thể tạo|vi phạm|chính sách".
11. Chờ kết quả (~25-50 s): ô `[role=group]` ĐẦU TIÊN có `img` `src` bắt đầu `http`, khác danh sách ô trước khi gửi, và không còn "%" trong text. Nhãn ô kết quả dạng "Edit <tên> image". Đừng dùng waitForFunction.
12. Tải: `download-lock acquire --tag <mục>`; chuột phải ô kết quả (hoặc hover + nút "Tuỳ chọn khác") > "Tải xuống" (hover/click để mở menu con) > "1K" ("Kích thước gốc"); mọi click `force:true`; chờ ~6-7 s.
13. Lấy file ngay: file mới nhất ở Downloads (`Edit_..._image_xxxx.jpg`, <60 s) đổi tên `workspace/tmp/flow-downloads/<mục>.<ext>`, kiểm kích thước và NHÌN ảnh, rồi `download-lock release`. Sau đó `register-image`.
14. Trong lúc chờ: KHÔNG đứng đợi một nhóm render xong mới gửi nhóm sau. Giữ tối đa 2 nhóm (≤ 6 prompt) đang render: gửi nhóm tiếp qua cùng `flow-pace gate` (trước MỖI prompt, giới hạn nguyên vẹn), rồi từng bước một: xem ô nào đã xong, tải (khoá tải), kiểm đúng mục, `register-image`. Cảnh báo / "unusual activity" / hết hạn mức / 3 prompt liền thất bại = dừng gửi, báo lỗi.

## Hay vướng
- Cửa sổ Chrome rất nhỏ (viewport ~2000x272, DPR 0.25): ảnh chụp màn hình vô dụng và nút bị che. Làm bằng DOM/`getByRole` + `force:true`; không resize.
- "not stable" / "intercepts pointer events" / click hết giờ: thêm `force:true`, hoặc Escape/click `.cdk-overlay-backdrop` rồi thử lại; cuối cùng `dispatchEvent('click')`.
- Click vào ô thư viện (thumbnail) mở chế độ sửa MỘT ảnh: bấm "Xong" để về dự án. Gắn ảnh bằng "Thêm vào câu lệnh", đừng click ảnh.
- Ô bị mờ (`flow-tile-container.dimmed`), nút "Tuỳ chọn khác" không hiện: thư viện đang ở chế độ chọn. Click vùng trống (ví dụ `page.mouse.click(3000,1500)`) để bỏ chọn rồi tải.
- Chỉ 1 chip trong câu lệnh sau "Thêm vào câu lệnh": bảng chọn đóng giữa chừng; mở dấu + lại rồi thêm ảnh còn lại; đếm chip trước khi gửi.
- Ảnh ra sai cảnh: gắn lại đúng thứ tự, làm lại ĐÚNG 1 lần cùng prompt.
- Tạo nhiều lệnh một lúc: một script cho đúng MỘT mục, mỗi bước ra kết quả JSON; không vòng lặp nhiều mục (Flow khoá tài khoản). Tab ẩn/nền bị Flow báo "unusual activity": luôn `bringToFront`.
