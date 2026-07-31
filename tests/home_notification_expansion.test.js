"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const backendRoot = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(
  path.join(backendRoot, "index.js"),
  "utf8",
);
const activitySource = fs.readFileSync(
  path.join(
    backendRoot,
    "domains",
    "notifications",
    "home_activity.js",
  ),
  "utf8",
);
const membershipSource = fs.readFileSync(
  path.join(
    backendRoot,
    "domains",
    "home",
    "home_membership.js",
  ),
  "utf8",
);
const actionRequestsSource = fs.readFileSync(
  path.join(
    backendRoot,
    "domains",
    "home",
    "home_action_requests.js",
  ),
  "utf8",
);
const workflowSource =
  `${indexSource}\n${activitySource}\n${membershipSource}\n${actionRequestsSource}`;

function expectAll(values) {
  for (const value of values) {
    assert.match(workflowSource, new RegExp(`['\"]${value}['\"]`));
  }
}

test("Home Notification cho phép đầy đủ nhóm kết quả thành viên mới", () => {
  expectAll([
    "share_request_accepted",
    "share_request_denied",
    "join_request_accepted",
    "join_request_denied",
    "transfer_owner_accepted",
    "transfer_owner_failed",
    "member_removed",
    "alarm_pause_cancelled",
  ]);
});

test("từ chối lời mời chỉ hợp lệ khi request gốc còn tồn tại", () => {
  assert.match(
    activitySource,
    /type === "share_request_denied"[\s\S]*SHARE DENIAL REQUEST NOT FOUND/,
  );
  assert.match(
    activitySource,
    /accounts\/\$\{requestedBy\}\/shareRequests\/\$\{homeId\}/,
  );
});

test("từ chối gia nhập chỉ do Owner hoặc Admin và phải có request gốc", () => {
  assert.match(
    activitySource,
    /type === "join_request_denied"[\s\S]*NO JOIN DENIAL PERMISSION[\s\S]*JOIN DENIAL REQUEST NOT FOUND/,
  );
  assert.match(
    activitySource,
    /accounts\/\$\{requestedBy\}\/shareRequests\/\$\{homeId\}_\$\{recipientUid\}/,
  );
});

test("từ chối chuyển chủ nhà chỉ gửi về đúng chủ nhà cũ", () => {
  assert.match(
    activitySource,
    /type === "transfer_owner_failed"[\s\S]*INVALID TRANSFER FAILURE RECIPIENT[\s\S]*TRANSFER FAILURE REQUEST NOT FOUND/,
  );
});

test("chuyển chủ nhà thành công tạo Home Notification cho cả hai bên", () => {
  assert.match(
    membershipSource,
    /uid: oldOwnerUid[\s\S]*type: "transfer_owner_accepted"/,
  );
  assert.match(
    membershipSource,
    /uid: newOwnerUid[\s\S]*type: "transfer_owner_accepted"/,
  );
});

test("lỗi chuyển chủ nhà tạo thông báo thất bại có giới hạn dữ liệu lỗi", () => {
  assert.match(membershipSource, /TRANSFER OWNER FAILURE NOTIFICATION ERROR/);
  assert.match(membershipSource, /type: "transfer_owner_failed"/);
  assert.match(membershipSource, /slice\(\s*0,\s*200,?\s*\)/);
});

test("huỷ tạm dừng Alarm tạo thông báo hoạt động trở lại", () => {
  assert.match(
    actionRequestsSource,
    /action === "remove"[\s\S]*type: "alarm_pause_cancelled"[\s\S]*cancelled_early/,
  );
});

test("mọi kết quả nhắm một người không được ghi timeline của nhà", () => {
  assert.match(
    activitySource,
    /isTargeted &&[\s\S]*req\.writeHomeTimeline !== false[\s\S]*TARGET TIMELINE NOT ALLOWED/,
  );
});

test("backend trả kết quả xử lý trước khi App xoá request gốc", () => {
  assert.match(activitySource, /homeNotificationRequestResults/);
  assert.match(
    activitySource,
    /await publishRequestResult\("completed"\);[\s\S]*await snap\.ref\.remove\(\);/,
  );
  assert.match(
    activitySource,
    /await publishRequestResult\("rejected", reason\);[\s\S]*await snap\.ref\.remove\(\);/,
  );
});
