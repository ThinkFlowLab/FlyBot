import {
  ACESFilmicToneMapping, Box3, DirectionalLight, GLTFLoader, HemisphereLight,
  LoadingManager, MAX_GLB_BYTES, OrbitControls, PerspectiveCamera, Scene,
  Sphere, Spherical, Vector3, WebGLRenderer, validGlb,
} from './model3d-engine-0.187.0.mjs';

async function readModel(url, signal) {
  const target = new URL(url, window.location.href);
  if (target.origin !== window.location.origin || !['https:', 'http:', 'blob:'].includes(target.protocol)) {
    throw new Error('模型地址无效。');
  }
  const response = await fetch(target, {signal, credentials: 'same-origin', redirect: 'error'});
  const declared = Number(response.headers.get('content-length'));
  const limit = !response.headers.get('content-encoding') && declared > 0 ? declared : MAX_GLB_BYTES;
  if (!response.ok || !response.body || limit > MAX_GLB_BYTES || declared > MAX_GLB_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('无法读取 3D 模型。');
  }
  const bytes = new Uint8Array(limit);
  let length = 0;
  for await (const chunk of response.body) {
    if (chunk.byteLength > bytes.byteLength - length) throw new Error('3D 文件过大或长度无效。');
    bytes.set(chunk, length);
    length += chunk.byteLength;
  }
  const model = bytes.subarray(0, length);
  if (!validGlb(model)) throw new Error('无法预览这个 3D 文件。');
  return bytes.buffer.byteLength === length ? bytes.buffer : bytes.buffer.slice(0, length);
}

function disposeModel(model) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  const images = new Set();
  model.traverse(node => {
    if (node.geometry) geometries.add(node.geometry);
    for (const material of [node.material].flat().filter(Boolean)) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) {
    if (texture.image?.close) images.add(texture.image);
    texture.dispose();
  }
  for (const image of images) image.close();
}

export async function openModel3dViewer(container, url, {signal} = {}) {
  const buffer = await readModel(url, signal);
  const manager = new LoadingManager();
  manager.setURLModifier(value => {
    // The GLB contains its binary and textures. Only loader-created object URLs may be resolved.
    if (!value.startsWith('blob:') || new URL(value).origin !== window.location.origin) {
      throw new Error('模型引用了外部资源。');
    }
    return value;
  });
  const {scene: model} = await new GLTFLoader(manager).parseAsync(buffer, '');
  if (signal?.aborted) {
    disposeModel(model);
    signal.throwIfAborted();
  }
  const bounds = new Box3().setFromObject(model);
  const {center, radius} = bounds.getBoundingSphere(new Sphere());
  if (bounds.isEmpty() || !Number.isFinite(radius) || radius <= 0) {
    disposeModel(model);
    throw new Error('此文件没有可预览的模型。');
  }

  let renderer;
  try { renderer = new WebGLRenderer({antialias: true, alpha: true}); }
  catch (error) {
    disposeModel(model);
    throw error;
  }

  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', '3D 模型预览。拖动或使用方向键旋转。滚动或使用加减键缩放，按 Home 复位。');
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  const scene = new Scene();
  scene.add(model, new HemisphereLight(0xf5f7ff, 0x6b7280, 2.2));
  const key = new DirectionalLight(0xfff6e8, 2.7);
  key.position.set(4, 9, 6);
  scene.add(key);
  const camera = new PerspectiveCamera(38, 1, radius / 150, radius * 30);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(center);
  controls.minDistance = radius * 1.1;
  controls.maxDistance = radius * 12;
  controls.enablePan = false;
  const angle = new Spherical();
  let fitted = false;

  function draw() { renderer.render(scene, camera); }
  function reset() {
    const vertical = camera.fov * Math.PI / 360;
    const horizontal = Math.atan(Math.tan(vertical) * camera.aspect);
    const distance = radius / Math.sin(Math.min(vertical, horizontal)) * 1.08;
    controls.target.copy(center);
    camera.position.copy(new Vector3(1, 0.65, 1.4).normalize().multiplyScalar(distance).add(center));
    controls.update();
  }
  function resize() {
    const width = Math.floor(container.clientWidth);
    if (width < 1) return;
    const height = canvas.clientHeight || Math.round(Math.min(340, Math.max(180, width * 0.68)));
    if (camera.aspect !== width / height) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    renderer.setSize(width, height, false);
    if (!fitted) {
      fitted = true;
      reset();
    }
    draw();
    container.setAttribute('data-model3d-ready', '');
  }
  function keyboard(event) {
    const action = {ArrowLeft: [-0.16, 0], ArrowRight: [0.16, 0], ArrowUp: [0, -0.16], ArrowDown: [0, 0.16]}[event.key];
    if (!Array.isArray(action) && !['+', '=', '-', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return reset();
    angle.setFromVector3(camera.position.clone().sub(center));
    if (Array.isArray(action)) {
      angle.theta += action[0];
      angle.phi += action[1];
      angle.makeSafe();
    } else {
      angle.radius *= event.key === '-' ? 1.15 : 1 / 1.15;
    }
    camera.position.setFromSpherical(angle).add(center);
    controls.update();
  }
  const observer = new ResizeObserver(resize);
  let active = true;
  function dispose() {
    if (!active) return;
    active = false;
    signal?.removeEventListener('abort', dispose);
    observer.disconnect();
    canvas.removeEventListener('keydown', keyboard);
    controls.removeEventListener('change', draw);
    controls.dispose();
    disposeModel(model);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    container.removeAttribute('data-model3d-ready');
  }
  try {
    canvas.addEventListener('keydown', keyboard);
    controls.addEventListener('change', draw);
    signal?.addEventListener('abort', dispose, {once: true});
    container.append(canvas);
    observer.observe(container);
    resize();
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}
