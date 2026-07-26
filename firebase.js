"use strict";

// Entry point cũ đã ngừng sử dụng. Backend production chỉ khởi động từ
// index.js; giữ file này ở trạng thái vô hiệu để tránh vô tình nạp một
// service-account hoặc Firebase app thứ hai.
if (require.main === module) {
  console.error("firebase.js đã ngừng sử dụng. Hãy chạy index.js.");
  process.exitCode = 1;
}

module.exports = null;
