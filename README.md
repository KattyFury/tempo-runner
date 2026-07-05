# tempo-runner

Bot tự động gọi các dịch vụ trả phí trên **Tempo (MPP)** để giữ ví hoạt động, chạy **miễn phí trên GitHub Actions**. Não là **Claude Haiku** (trả bằng USDC qua Tempo — không cần tài khoản Anthropic).

Mỗi lượt: Haiku tự chọn 1 dịch vụ trong danh sách + tự soạn yêu cầu → gọi → ghi log. Dịch vụ nào lỗi 2 lần thì tự bị gạch. Có trần chi tiêu mỗi ngày để không vượt ngân sách.

## Cần gì

- **1 ví Tempo có ~$5 USDC.e** (coi như ví "cháy được", đừng để nhiều tiền).
- Private key của ví đó.

## Cài trong 4 bước

1. **Fork** repo này.
2. Vào **Settings → Secrets and variables → Actions → New repository secret**:
   - Tên: `TEMPO_PRIVATE_KEY` — Giá trị: private key ví Tempo của bạn.
   - (tuỳ chọn) Tab **Variables** thêm `DAILY_CAP` = `0.16` (~$5/tháng). Muốn tốn ít hơn thì để số nhỏ hơn.
3. Vào tab **Actions**, bật workflow.
4. Bấm **Run workflow** để chạy thử tay, hoặc chờ cron tự chạy (07:00–22:30 giờ VN).

Log nằm trong `state/log.txt`, tự cập nhật về repo sau mỗi lần chạy.

## Test miễn phí trước khi tốn tiền

```bash
# Chạy giả lập 15 lượt, không gọi mạng, không mất xu nào:
MODE=mock FORCE_ACTIVE=1 MOCK_ITERS=15 node engine.mjs
```

## Chỉnh gì

- **Danh sách dịch vụ**: sửa `services.json`.
- **Ngân sách/ngày**: biến `DAILY_CAP` (mặc định $0.16 ≈ $5/tháng).
- **Trần mỗi lượt gọi não**: `HAIKU_MAX_SPEND` (mặc định $0.05).

## ⚠️ Lưu ý an toàn

- **Chỉ nạp ít tiền** vào ví (khoảng $5). Private key nằm trong GitHub Secret — không bao giờ commit ra code.
- Để repo **public** thì Actions mới miễn phí không giới hạn phút.
