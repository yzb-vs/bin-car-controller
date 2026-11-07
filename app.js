'use strict';

// KT6368A default BLE service/characteristic. 08 工程的串口2每次接收一个数值命令。
const SERVICE = 0xfff0;
const CHARACTERISTIC = 0xfff1;
const STOP = 13;
const $ = id => document.getElementById(id);
const pad = $('pad'), knob = $('knob'), connect = $('connect');
let device = null, characteristic = null, generation = 0;
let padPointer = null, direction = STOP, closing = false;
let pending = [], sending = null;
const labels = {1: '前进', 2: '后退', 9: '左转', 10: '右转', 13: '停车'};

function status(message, connected = false) {
  $('status').textContent = message;
  $('dot').classList.toggle('on', connected);
}
function notice(message) { $('notice').textContent = message; }
// 控制帧：AA 55、类型01、长度01、命令、异或校验。
function submit(command) {
  if (!characteristic || closing) return;
  if (command === STOP || command === 14) pending = []; // 停车优先，取消还没发出的动作。
  pending.push(command);
  if (!sending) {
    const session = generation;
    sending = drain(session).finally(() => { if (session === generation) sending = null; });
  }
  return sending;
}
async function drain(session) {
  try {
    while (pending.length && session === generation) {
      const command = pending.shift();
      const type = 0x01, length = 0x01;
      const data = Uint8Array.of(0xaa, 0x55, type, length, command, type ^ length ^ command);
      if (characteristic.properties.writeWithoutResponse)
        await characteristic.writeValueWithoutResponse(data);
      else
        await characteristic.writeValueWithResponse(data);
    }
  } catch (error) {
    if (session === generation) {
      notice('发送失败，请检查小车是否已停车。');
      disconnect();
    }
  }
}
function resetInput() {
  direction = STOP; padPointer = null;
  delete pad.dataset.direction;
  knob.style.transform = '';
  $('direction').textContent = '已松开';
}
function emergencyStop(message, command = STOP) {
  resetInput();
  if (message) notice(message);
  return submit(command);
}
function disconnect() {
  generation++; pending = []; sending = null; characteristic = null;
  closing = false; resetInput();
  const old = device; device = null;
  if (old && old.gatt.connected) old.gatt.disconnect();
  connect.disabled = false; connect.textContent = '连接蓝牙';
  status('未连接');
}
connect.addEventListener('click', async () => {
  if (characteristic) {
    connect.disabled = true;
    const stopped = emergencyStop();
    closing = true;
    await stopped; // 主动断开前，先等停车指令写完。
    disconnect(); return;
  }
  if (!window.isSecureContext || !navigator.bluetooth) {
    notice('请用安卓 Chrome 打开 HTTPS 网页，并开启蓝牙。');
    return;
  }
  connect.disabled = true; notice(''); status('正在选择蓝牙设备…');
  try {
    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true, optionalServices: [SERVICE]
    });
    device.addEventListener('gattserverdisconnected', event => {
      if (event.target !== device) return;
      notice('蓝牙意外断开，请检查小车是否已停车。');
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
    submit(STOP);
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
  // 横屏控制台直接使用手指在摇杆中的位置。
  let x = (event.clientX - (r.left + r.width / 2)) / (r.width * .34);
  let y = (event.clientY - (r.top + r.height / 2)) / (r.height * .34);
  const length = Math.hypot(x, y);
  if (length > 1) { x /= length; y /= length; }
  knob.style.transform = `translate(${x * r.width * .30}px,${y * r.height * .30}px)`;
  // 模式1：按偏移较大的轴选四方向，中心留出死区防止误触。
  const next = length < .25 ? STOP : Math.abs(y) >= Math.abs(x)
    ? (y < 0 ? 1 : 2) : (x < 0 ? 9 : 10);
  if (next === direction) return;
  direction = next;
  pad.dataset.direction = next;
  $('direction').textContent = labels[next];
  submit(next);
}
pad.addEventListener('pointerdown', event => {
  if (!characteristic || closing || padPointer !== null) return;
  event.preventDefault(); padPointer = event.pointerId;
  pad.setPointerCapture(event.pointerId); move(event);
});
pad.addEventListener('pointermove', move);
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture'])
  pad.addEventListener(eventName, event => {
    if (event.pointerId === padPointer) emergencyStop();
  });
// 加减速每点一次只发送一次；松开按钮不改变摇杆方向。
document.querySelectorAll('[data-command]').forEach(button => {
  button.addEventListener('click', () => submit(Number(button.dataset.command)));
});
$('stop').addEventListener('click', () => emergencyStop());
$('brake').addEventListener('click', () => emergencyStop('', 14));
window.addEventListener('blur', () => { if (characteristic) emergencyStop(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && characteristic) emergencyStop();
});
if (!window.isSecureContext || !navigator.bluetooth)
  notice('蓝牙控制需要安卓 Chrome 和 HTTPS 地址。');


// 有全屏能力的浏览器才显示按钮，退出全屏后同步更新文字。
const full = $('fullscreen');
if (document.fullscreenEnabled) {
  full.hidden = false;
  full.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (_) { notice('浏览器未进入全屏，仍可横屏驾驶。'); }
  });
  document.addEventListener('fullscreenchange', () => {
    full.textContent = document.fullscreenElement ? '退出全屏' : '全屏驾驶';
  });
}
