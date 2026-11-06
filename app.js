'use strict';

// KT6368A default BLE service/characteristic. Data matches bsp_cfun.c.
const SERVICE = 0xfff0;
const CHARACTERISTIC = 0xfff1;
const PERIOD_MS = 150;
const $ = id => document.getElementById(id);
const pad = $('pad'), knob = $('knob'), connect = $('connect');
let device = null, characteristic = null, timer = null, writing = false;
let pending = [], generation = 0, padPointer = null;
let horizontal = 0, vertical = 0, keys = [0, 0, 0, 0];
const activeButtons = new Map();

function status(message, connected = false) {
  $('status').textContent = message;
  $('dot').classList.toggle('on', connected);
}
function notice(message) { $('notice').textContent = message; }
function packet() {
  // Firmware maps its first axis to left/right and the negative second to up/down.
  return new Uint8Array([0xdd, 0x77, horizontal & 255, vertical & 255, ...keys]);
}
function submit(kind = 'state') {
  if (!characteristic) return;
  const value = packet();
  if (kind === 'stop') {
    // A stop supersedes queued motion; no stale movement may follow it.
    pending = [{value, kind}];
  } else if (kind === 'tick') {
    if (pending.length) return;
    pending.push({value, kind});
  } else {
    if (pending.length >= 8) {
      emergencyStop('发送繁忙，已停止，请重新连接。');
      return;
    }
    pending.push({value, kind});
  }
  drain();
}
async function drain() {
  if (writing || !characteristic) return;
  writing = true;
  const session = generation;
  try {
    while (pending.length && characteristic && session === generation) {
      const item = pending.shift();
      if (characteristic.properties.writeWithoutResponse)
        await characteristic.writeValueWithoutResponse(item.value);
      else
        await characteristic.writeValueWithResponse(item.value);
    }
  } catch (error) {
    if (session === generation) {
      notice('蓝牙发送失败，小车应在超时后停车：' + (error.message || error));
      disconnect();
    }
  } finally {
    writing = false;
    if (pending.length && characteristic) drain();
  }
}
function resetInput() {
  horizontal = 0; vertical = 0; keys = [0, 0, 0, 0];
  activeButtons.clear(); padPointer = null;
  knob.style.transform = '';
  $('direction').textContent = '已松开';
}
function stopMotion() {
  horizontal = 0; vertical = 0; padPointer = null;
  knob.style.transform = '';
  $('direction').textContent = '已松开';
  submit('stop');
}
function emergencyStop(message) {
  resetInput();
  submit('stop');
  if (message) notice(message);
}
function disconnect() {
  generation++;
  clearInterval(timer); timer = null;
  pending = []; characteristic = null;
  resetInput();
  if (device && device.gatt.connected) device.gatt.disconnect();
  device = null; connect.disabled = false; connect.textContent = '连接蓝牙';
  status('未连接');
}
connect.addEventListener('click', async () => {
  if (characteristic) { emergencyStop(); disconnect(); return; }
  if (!window.isSecureContext || !navigator.bluetooth) {
    notice('请用安卓 Chrome 打开 HTTPS 网页，并开启蓝牙。');
    return;
  }
  connect.disabled = true; notice(''); status('正在选择蓝牙设备…');
  try {
    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true, optionalServices: [SERVICE]
    });
    device.addEventListener('gattserverdisconnected', () => {
      notice('蓝牙已断开；请松开摇杆后重新连接。');
      disconnect();
    }, {once:true});
    status('正在连接…');
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE);
    try {
      characteristic = await service.getCharacteristic(CHARACTERISTIC);
      if (!characteristic.properties.write && !characteristic.properties.writeWithoutResponse)
        characteristic = null;
    } catch (_) { characteristic = null; }
    if (!characteristic) characteristic = await service.getCharacteristic(0xfff3);
    resetInput(); pending = []; generation++;
    connect.textContent = '断开连接'; connect.disabled = false;
    status('已连接 · ' + (device.name || '蓝牙设备'), true);
    submit('stop');
    timer = setInterval(() => submit('tick'), PERIOD_MS);
  } catch (error) {
    const detail = String(error.message || error);
    if (error.name === 'NotSupportedError' || /not supported on this platform/i.test(detail))
      notice('当前浏览器不支持网页蓝牙。请复制网址，用安卓手机的 Google Chrome 浏览器打开后重试。');
    else if (error.name === 'NotFoundError' && !device)
      notice('没有选择蓝牙设备。请确认小车已上电，再点击连接并选择“斌车”。');
    else if (error.name === 'NotFoundError')
      notice('设备已选中，但没有找到默认蓝牙服务。请确认选择的是斌车的 BLE 设备。');
    else
      notice('蓝牙连接失败：' + detail + '。请先关闭创趣蓝牙，再选择斌车的 BLE 设备。');
    disconnect();
  }
});
function move(event) {
  if (event.pointerId !== padPointer || !characteristic) return;
  const r = pad.getBoundingClientRect();
  // 竖持手机时画面旋转了90度，触摸坐标也要转换回摇杆坐标。
  const rotated = window.matchMedia('(orientation: portrait)').matches;
  let x = rotated ? (event.clientY - (r.top + r.height / 2)) / (r.height * .34)
                  : (event.clientX - (r.left + r.width / 2)) / (r.width * .34);
  let y = rotated ? -(event.clientX - (r.left + r.width / 2)) / (r.width * .34)
                  : (event.clientY - (r.top + r.height / 2)) / (r.height * .34);
  const length = Math.hypot(x, y);
  if (length > 1) { x /= length; y /= length; }
  knob.style.transform = `translate(${x * r.width * .30}px,${y * r.height * .30}px)`;
  horizontal = Math.round(x * 100);
  vertical = Math.round(-y * 100);
  $('direction').textContent = Math.hypot(x, y) < .25 ? '回中' : '控制中';
  submit('tick');
}
pad.addEventListener('pointerdown', event => {
  if (!characteristic || padPointer !== null) return;
  event.preventDefault(); padPointer = event.pointerId;
  pad.setPointerCapture(event.pointerId); move(event);
});
pad.addEventListener('pointermove', move);
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture'])
  pad.addEventListener(eventName, event => {
    if (event.pointerId === padPointer) stopMotion();
  });
document.querySelectorAll('[data-key]').forEach(button => {
  const key = Number(button.dataset.key);
  button.addEventListener('pointerdown', event => {
    if (!characteristic || activeButtons.has(key)) return;
    event.preventDefault(); activeButtons.set(key, event.pointerId);
    button.setPointerCapture(event.pointerId); keys[key] = 1; submit();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
    button.addEventListener(name, event => {
      if (activeButtons.get(key) !== event.pointerId) return;
      activeButtons.delete(key); keys[key] = 0; submit();
    });
});
$('stop').addEventListener('click', () => emergencyStop('已发送停车指令。'));
window.addEventListener('blur', () => { if (characteristic) emergencyStop(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && characteristic) emergencyStop();
});
if (!window.isSecureContext || !navigator.bluetooth)
  notice('蓝牙控制需要安卓 Chrome 和 HTTPS 地址。');

