// Termux 身体适配器：传感器按名字探测（各手机命名不同），没有 Termux:API 时不崩溃。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickSensors } from "../adapters/termux/termux.ts";

test("从各家手机的传感器列表里挑出光线与加速度", () => {
  assert.deepEqual(pickSensors(["accelerometer-bmi160", "mag-akm09911", "light-bh1745", "proximity-pa224", "gyroscope-bmi160", "linearAcceleration"]),
    { light: "light-bh1745", accel: "accelerometer-bmi160" });
  assert.deepEqual(pickSensors(["TMD4906 Light", "LSM6DSO Accelerometer Uncalibrated", "LSM6DSO Accelerometer", "LSM6DSO Gyroscope"]),
    { light: "TMD4906 Light", accel: "LSM6DSO Accelerometer" });
  assert.deepEqual(pickSensors(["Linear Acceleration", "Accelerometer-Wakeup", "Accelerometer"]), { light: undefined, accel: "Accelerometer" });
  assert.deepEqual(pickSensors([]), { light: undefined, accel: undefined });
});

test("没有 Termux:API 的机器上：采样为空、描述仍然成立", async () => {
  process.env.PATH = "/nonexistent";
  const { default: adapter } = await import("../adapters/termux/index.ts");
  await adapter.init!();
  assert.equal(adapter.name, "termux");
  assert.match(adapter.describe, /安卓手机/);
  assert.deepEqual(await adapter.sample(), { battery: undefined, lux: undefined, motion: undefined, extra: undefined });
  const sensor = adapter.tools!.find((t) => t.name === "read_sensor")!;
  await assert.rejects(sensor.handler({}), /没有读到传感器列表/);
});
