import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const portraits = {
  prenatal: {
    title: 'Prenatal keepsake',
    description: 'An artistic interpretation of a profile, with imagined depth and unseen features.',
    alt: 'Artistic clay portrait inspired by a prenatal profile. Invented three-dimensional detail.',
    model: 'output/models/prenatal.glb',
    preview: 'output/imagegen/prenatal-concept.png',
    previewSrcset: 'output/imagegen/prenatal-concept-600.webp 600w, output/imagegen/prenatal-concept-full.webp 1199w',
    previewWidth: 1199,
    previewHeight: 1312,
  },
  'age-one': {
    title: 'Imagined at one',
    description: 'An imagined portrait, not a prediction.',
    alt: 'An imagined clay portrait at one year old. This is not a prediction of the child’s appearance.',
    model: 'output/models/age-one.glb',
    preview: 'output/imagegen/age-one-concept.png',
    previewSrcset: 'output/imagegen/age-one-concept-600.webp 600w, output/imagegen/age-one-concept-full.webp 1145w',
    previewWidth: 1145,
    previewHeight: 1374,
  },
};

const stage = document.querySelector('#model-stage');
const canvas = document.querySelector('#portrait-canvas');
const preview = document.querySelector('#portrait-preview');
const previewSource = document.querySelector('#portrait-webp');
const message = document.querySelector('#load-message');
const retry = document.querySelector('#retry-load');
const mode = document.querySelector('#stage-mode');
const autoButton = document.querySelector('#auto-rotate');
const actionButtons = [...document.querySelectorAll('[data-action]')];
const pickerButtons = [...document.querySelectorAll('[data-portrait]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const cachedModels = new Map();
const cameraOffset = new THREE.Vector3();
const spherical = new THREE.Spherical();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, .01, 100);
const loader = new GLTFLoader();
let renderer;
let controls;
let activeModel;
let activeKey = 'prenatal';
let requestId = 0;
let ready = false;
let frameRequested = false;
let initialDistance = 4;
let lastRenderTime = performance.now();

scene.background = new THREE.Color('#e8ece3');
scene.add(new THREE.HemisphereLight(0xffffff, 0xa5b4a1, 1.5));
const keyLight = new THREE.DirectionalLight(0xfff6e9, 2.5);
keyLight.position.set(-3, 5, 5);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0xf1f7f4, .7);
fillLight.position.set(4, 1, 2);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 1.3);
rimLight.position.set(1, 3, -4);
scene.add(rimLight);

function announce(text) { message.textContent = text; }

function setReady(value) {
  ready = value;
  actionButtons.forEach(button => { button.disabled = !value; });
  autoButton.disabled = !value || reducedMotion.matches;
  autoButton.title = reducedMotion.matches ? 'Slow rotation is off while Reduce Motion is enabled.' : '';
  canvas.hidden = !value;
  preview.hidden = value;
  mode.textContent = value ? 'Interactive 3D sculpture' : 'Still portrait';
}

function setAutoRotate(value) {
  if (controls) controls.autoRotate = Boolean(value && ready && !reducedMotion.matches);
  autoButton.setAttribute('aria-pressed', String(Boolean(controls?.autoRotate)));
  requestRender();
}

function render(timestamp) {
  frameRequested = false;
  if (!renderer || !ready || document.hidden) return;
  const delta = Math.min((timestamp - lastRenderTime) / 1000, .05);
  lastRenderTime = timestamp;
  controls.update(delta);
  renderer.render(scene, camera);
  if (controls.autoRotate) requestRender();
}

function requestRender() {
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(render);
  }
}

function resize() {
  if (!renderer) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (ready) resetView();
}

function resetView() {
  if (!controls) return;
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  initialDistance = .98 / Math.sin(Math.min(verticalFov, horizontalFov) / 2);
  controls.target.set(0, 0, 0);
  camera.position.copy(new THREE.Vector3(.20, .05, 1).normalize().multiplyScalar(initialDistance));
  controls.minDistance = initialDistance * .48;
  controls.maxDistance = initialDistance * 2.1;
  camera.near = .01;
  camera.far = initialDistance * 10;
  camera.updateProjectionMatrix();
  controls.update();
  requestRender();
}

function setupRenderer() {
  if (renderer) {
    if (renderer.getContext().isContextLost()) throw new Error('The graphics context is unavailable.');
    return;
  }
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .95;
  controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.enableDamping = false;
  controls.autoRotateSpeed = .45;
  controls.minPolarAngle = .15;
  controls.maxPolarAngle = Math.PI - .15;
  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', () => setAutoRotate(false));
  new ResizeObserver(resize).observe(stage);
  resize();
}

function prepareModel(object) {
  object.traverse(node => {
    if (!node.isMesh) return;
    if (!node.geometry.getAttribute('normal')) node.geometry.computeVertexNormals();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach(material => {
      if (!material.isMeshStandardMaterial) return;
      material.metalness = 0;
      material.roughness = .9;
      material.flatShading = false;
      material.needsUpdate = true;
    });
  });
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) throw new Error('The model contains no visible geometry.');
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error('Invalid model dimensions.');
  const group = new THREE.Group();
  group.add(object);
  object.position.sub(sphere.center);
  group.scale.setScalar(1 / sphere.radius);
  return group;
}

function showFailure() {
  setReady(false);
  stage.setAttribute('aria-busy', 'false');
  retry.hidden = false;
  announce('The 3D view could not open. You can still view the portrait or save the model.');
}

async function selectPortrait(key) {
  const portrait = portraits[key];
  const currentRequest = ++requestId;
  activeKey = key;
  setAutoRotate(false);
  setReady(false);
  stage.setAttribute('aria-busy', 'true');
  retry.hidden = true;
  pickerButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.portrait === key)));
  document.querySelector('#portrait-title').textContent = portrait.title;
  document.querySelector('#portrait-description').textContent = portrait.description;
  document.querySelector('#download-model').href = portrait.model;
  document.querySelector('#download-portrait').href = portrait.preview;
  previewSource.srcset = portrait.previewSrcset;
  preview.width = portrait.previewWidth;
  preview.height = portrait.previewHeight;
  preview.src = portrait.preview;
  preview.alt = portrait.alt;
  canvas.setAttribute('aria-label', `Interactive ${portrait.title.toLowerCase()}. Use arrow keys to rotate, plus or minus to zoom, and Home to reset.`);
  announce('Loading the sculpture…');
  try {
    setupRenderer();
    let model = cachedModels.get(key);
    if (!model) {
      const gltf = await loader.loadAsync(portrait.model);
      model = prepareModel(gltf.scene);
      cachedModels.set(key, model);
    }
    if (currentRequest !== requestId) return;
    if (activeModel) scene.remove(activeModel);
    activeModel = model;
    scene.add(model);
    setReady(true);
    stage.setAttribute('aria-busy', 'false');
    resetView();
    renderer.render(scene, camera);
    announce('');
  } catch (error) {
    if (currentRequest !== requestId) return;
    showFailure();
  }
}

function action(name) {
  if (!ready) return;
  setAutoRotate(false);
  if (name === 'reset') { resetView(); return; }
  cameraOffset.copy(camera.position).sub(controls.target);
  spherical.setFromVector3(cameraOffset);
  const step = Math.PI / 16;
  if (name === 'left') spherical.theta -= step;
  if (name === 'right') spherical.theta += step;
  if (name === 'up') spherical.phi -= step;
  if (name === 'down') spherical.phi += step;
  if (name === 'in') spherical.radius *= .88;
  if (name === 'out') spherical.radius /= .88;
  spherical.phi = THREE.MathUtils.clamp(spherical.phi, controls.minPolarAngle, controls.maxPolarAngle);
  spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
  camera.position.copy(cameraOffset.setFromSpherical(spherical).add(controls.target));
  controls.update();
  requestRender();
}

pickerButtons.forEach(button => button.addEventListener('click', () => selectPortrait(button.dataset.portrait)));
actionButtons.forEach(button => button.addEventListener('click', () => action(button.dataset.action)));
autoButton.addEventListener('click', () => setAutoRotate(!controls?.autoRotate));
retry.addEventListener('click', () => selectPortrait(activeKey));
canvas.addEventListener('keydown', event => {
  const actions = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', _: 'out', Home: 'reset' };
  if (!actions[event.key]) return;
  event.preventDefault();
  action(actions[event.key]);
});
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  ++requestId;
  setAutoRotate(false);
  showFailure();
});
canvas.addEventListener('webglcontextrestored', () => selectPortrait(activeKey));
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) setAutoRotate(false);
  autoButton.disabled = !ready || reducedMotion.matches;
  autoButton.title = reducedMotion.matches ? 'Slow rotation is off while Reduce Motion is enabled.' : '';
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { lastRenderTime = performance.now(); requestRender(); }
});

selectPortrait('prenatal');
