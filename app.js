'use strict';

// KT6368A default BLE service/characteristic. 08 工程的串口2每次接收一个数值命令。
const SERVICE = 0xfff0;
const CHARACTERISTIC = 0xfff1;
const STOP = 13, LINE_START = 17;
const $ = id => document.getElementById(id);
const pad = $('pad'), knob = $('knob'), connect = $('connect');
let device = null, characteristic = null, generation = 0;
let padPointer = null, motionPointer = null, direction = STOP, closing = false;
let pending = [], sending = null, mode = 1;
const labels = {1: '前进', 2: '后退', 3: '左平移', 4: '右平移', 11: '原地左旋', 12: '原地右旋', 5: '左前斜行', 6: '右前斜行', 7: '左后斜行', 8: '右后斜行', 9: '左转', 10: '右转', 13: '停车'};

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
  direction = STOP; padPointer = null; motionPointer = null;
  delete pad.dataset.direction;
  knob.style.transform = '';
  $('direction').textContent = mode === 4 ? '等待启动' : mode !== 1 ? '按住运动 · 松开刹车' : '已松开';
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
  // 模式1控制四方向；模式2需要同时向水平和垂直方向推动。
  let next = STOP;
  if (mode === 1 && length >= .25)
    next = Math.abs(y) >= Math.abs(x) ? (y < 0 ? 1 : 2) : (x < 0 ? 9 : 10);
  else if (mode === 2 && Math.abs(x) >= .18 && Math.abs(y) >= .18)
    next = y < 0 ? (x < 0 ? 5 : 6) : (x < 0 ? 7 : 8);
  else if (mode === 5 && length >= .25)
    next = Math.abs(y) >= Math.abs(x) ? (y < 0 ? 11 : 12) : (x < 0 ? 3 : 4);
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
    if (event.pointerId === padPointer) emergencyStop('', 14);
  });
// 切换模式先停车并释放摇杆，避免旧方向延续到新模式。
function selectMode(nextMode) {
  if (mode === nextMode) return;
  emergencyStop();
  mode = nextMode;
  $('control-title').textContent = mode === 4 ? '循迹控制' : mode !== 1 ? '方向按钮' : '方向摇杆';
  $('direction').textContent = mode === 4 ? '等待启动' : mode !== 1 ? '按住运动 · 松开刹车' : '已松开';
  $('current-mode').textContent = {1:'01 · 手动驾驶', 2:'02 · 四方向斜行', 4:'04 · 循迹', 5:'05 · 平移与旋转'}[mode];
  $('mode1').setAttribute('aria-pressed', String(mode === 1));
  $('mode2').setAttribute('aria-pressed', String(mode === 2));
  $('mode5').setAttribute('aria-pressed', String(mode === 5));
  $('mode4').setAttribute('aria-pressed', String(mode === 4));
  pad.dataset.mode = String(mode);
  pad.hidden = mode !== 1;
  $('mode2-controls').hidden = mode !== 2;
  $('mode5-controls').hidden = mode !== 5;
  $('mode4-controls').hidden = mode !== 4;
  document.querySelectorAll('[data-command]').forEach(button => { button.disabled = mode === 4; });
  const arrows = mode === 2 ? ['↖', '↘', '↙', '↗'] : mode === 5 ? ['↺', '↻', '◀', '▶'] : ['▲', '▼', '◀', '▶'];
  pad.querySelectorAll('.arrow').forEach((arrow, i) => { arrow.textContent = arrows[i]; });
}
$('mode1').addEventListener('click', () => selectMode(1));
$('mode2').addEventListener('click', () => selectMode(2));
$('mode5').addEventListener('click', () => selectMode(5));
$('mode4').addEventListener('click', () => selectMode(4));
$('line-start').addEventListener('click', () => {
  if (!characteristic || closing || mode !== 4) { notice('请先连接蓝牙，再启动循迹。'); return; }
  submit(LINE_START);
  $('direction').textContent = '已请求启动（无回传）';
});
// 模式2和5按住运动，松开、触摸取消或失去捕获时发送刹车。
document.querySelectorAll('[data-motion]').forEach(button => {
  button.addEventListener('pointerdown', event => {
    if ((mode !== 2 && mode !== 5) || !characteristic || closing || motionPointer !== null) return;
    event.preventDefault();
    motionPointer = event.pointerId;
    button.setPointerCapture(event.pointerId);
    const command = Number(button.dataset.motion);
    $('direction').textContent = labels[command];
    submit(command);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'])
    button.addEventListener(name, event => {
      if (event.pointerId === motionPointer) emergencyStop('', 14);
    });
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
