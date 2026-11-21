# Product Review

[Tải bản mới nhất](https://github.com/hoangpham2263/product-review/releases/latest/download/product-review.zip) · [Trang tải](https://hoangpham2263.github.io/product-review/)

- Ảnh nguồn: [product-review-sources](https://github.com/hoangpham2263/product-review-sources)
- Ảnh kết quả: [product-review-results](https://github.com/hoangpham2263/product-review-results) (ghi qua Worker `worker/`)
- Phát hành: push tag `vX.Y.Z`; app nhận bản mới ở nút **Cập nhật**.
- Kiểu chạy chọn riêng mỗi lượt: "Ảnh + review" (mặc định) hoặc "Chỉ viết review" (không tạo ảnh, không upload; review viết từ ảnh review gốc, CSV Loox để trống cột ảnh).
- Viết review chọn được Codex, Antigravity CLI hoặc Claude (Claude Code CLI, `claude -p`, chỉ đọc ảnh review; không bắt buộc cài, đặt `PR_CLAUDE_CLI` nếu không có trong PATH).

## Nhiều cửa sổ (phiên)
Mở thêm cửa sổ chạy dự án khác: nút "Các phiên" > "Mở cửa sổ mới" trong app, hoặc `start-app.cmd <tên-phiên>`. Mỗi phiên có hàng chờ, log và cổng riêng (`workspace-sessions/<tên>/`); cấu hình, danh sách dự án và ảnh nguồn dùng chung.
