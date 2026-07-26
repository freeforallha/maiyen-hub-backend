"use strict";

// Migration cấu trúc thử nghiệm cũ đã bị vô hiệu để không thể ghi nhầm dữ
// liệu production. Các migration hiện hành nằm trong thư mục scripts/ và đều
// mặc định DRY RUN, có backup cùng câu xác nhận APPLY riêng.
console.error(
  "migrate_structure.js đã ngừng sử dụng. Dùng migration an toàn trong scripts/.",
);
process.exitCode = 1;
