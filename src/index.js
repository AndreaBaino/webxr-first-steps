/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import * as THREE from 'three';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Text } from 'troika-three-text';
import { XR_BUTTONS } from 'gamepad-wrapper';
import { gsap } from 'gsap';
import { init } from './init.js';

const bullets = {};
const forwardVector = new THREE.Vector3(0, 0, -1);
const bulletSpeed = 10;
const bulletTimeToLive = 1;

const blasterGroup = new THREE.Group();
const targets = [];

// Inerzia/oscillazione blaster in base al movimento
const blasterInertia = {
	prevPos: new THREE.Vector3(),
	tiltY: 0,
	tiltZ: 0,
	sensitivity: 2.5,
	damping: 8,
	maxTilt: 0.12,
};

// Sfere con liquido finto (due occhi) - piani sempre verso l'alto (giroscopio)
const liquidSpheresContainer = new THREE.Group();
const liquidMeshes = []; // [{ mesh, inertia }, ...]
const liquidBaseQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const liquidParentWorldQuat = new THREE.Quaternion();
const liquidInertiaEuler = new THREE.Euler(0, 0, 0, 'XYZ');
const liquidInertiaQuat = new THREE.Quaternion();
const liquidSphereInertia = {
	prevPos: new THREE.Vector3(),
	prevQuat: new THREE.Quaternion(),
	hasPrevQuat: false,
	tiltX: 0,
	tiltY: 0,
	tiltZ: 0,
	velX: 0,
	velY: 0,
	velZ: 0,
	sensitivity: 3,
	spring: 12,
	damping: 4,
	maxTilt: 0.18,
	gyroSensitivity: 0.015,
};
const gyroRate = { alpha: 0, beta: 0, gamma: 0 }; // DeviceMotion deg/s

let score = 0;
const scoreText = new Text();
scoreText.fontSize = 0.52;
scoreText.font = 'assets/SpaceMono-Bold.ttf';
scoreText.position.z = -2;
scoreText.color = 0xffa276;
scoreText.anchorX = 'center';
scoreText.anchorY = 'middle';

let laserSound, scoreSound;

const VIDEO_MP4_URL = 'assets/acuvue.mp4';
let videoPlaneMesh = null;
let videoTexturePlane = null;
let videoElement = null;
let playPauseIconMesh = null;
let pointerElRef = null;
const raycaster = new THREE.Raycaster();
const pointerCoords = new THREE.Vector2();

const PLAY_ICON_SIZE = 128;

function drawPlayPauseIcon(ctx, isPaused) {
	ctx.fillStyle = '#1a1a1a';
	ctx.fillRect(0, 0, PLAY_ICON_SIZE, PLAY_ICON_SIZE);
	ctx.fillStyle = 'rgba(255,255,255,0.95)';
	if (isPaused) {
		// Triangolo play
		ctx.beginPath();
		ctx.moveTo(32, 24);
		ctx.lineTo(32, 104);
		ctx.lineTo(96, 64);
		ctx.closePath();
		ctx.fill();
	} else {
		// Due barre pause
		ctx.fillRect(36, 28, 20, 72);
		ctx.fillRect(72, 28, 20, 72);
	}
}

function createPlayPauseTexture() {
	const canvas = document.createElement('canvas');
	canvas.width = PLAY_ICON_SIZE;
	canvas.height = PLAY_ICON_SIZE;
	const ctx = canvas.getContext('2d');
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	return { canvas, ctx, texture, update(isPaused) {
		drawPlayPauseIcon(ctx, isPaused);
		texture.needsUpdate = true;
	} };
}

function updateScoreDisplay() {
	const clampedScore = Math.max(0, Math.min(9999, score));
	const displayScore = clampedScore.toString().padStart(4, '0');
	scoreText.text = displayScore;
	scoreText.sync();
}

function setupScene({ scene, camera, renderer, css3dScene }) {
	// Due sfere con liquido (occhi) davanti alla camera
	const sphereRadius = 0.15;
	const eyeOffset = 0.2;
	const leftInertia = 1;
	const rightInertia = 0.1;
	const glassGeometry = new THREE.SphereGeometry(sphereRadius, 32, 32);
	const glassMaterial = new THREE.MeshPhysicalMaterial({
		color: 0x88aacc,
		transparent: true,
		opacity: 0.25,
		roughness: 0.1,
		metalness: 0,
		transmission: 0.9,
		thickness: 0.02,
		side: THREE.FrontSide,
	});
	const liquidGeometry = new THREE.CircleGeometry(sphereRadius * 0.88, 32);
	const liquidMaterial = new THREE.MeshPhysicalMaterial({
		color: 0x44aaff,
		roughness: 0.2,
		metalness: 0,
		side: THREE.DoubleSide,
	});

	const inertias = [leftInertia, rightInertia];
	for (let i = 0; i < 2; i++) {
		const x = i === 0 ? -eyeOffset : eyeOffset;
		const group = new THREE.Group();
		group.position.x = x;

		const glassSphere = new THREE.Mesh(glassGeometry.clone(), glassMaterial);
		group.add(glassSphere);

		const liquidMesh = new THREE.Mesh(liquidGeometry.clone(), liquidMaterial);
		liquidMesh.position.y = -sphereRadius * 0.35;
		liquidMesh.renderOrder = 1;
		group.add(liquidMesh);
		liquidMeshes.push({ mesh: liquidMesh, inertia: inertias[i] });

		liquidSpheresContainer.add(group);
	}

	liquidSpheresContainer.position.set(0, 0, -1.2);
	liquidSpheresContainer.scale.setScalar(0.8);
	camera.add(liquidSpheresContainer);
	camera.getWorldPosition(liquidSphereInertia.prevPos);

	// Piano video 16:9 in VR (video locale)
	const videoWidth = 4.8;
	const videoHeight = (videoWidth * 9) / 16;
	const videoZ = -6;
	const videoGroup = new THREE.Group();
	videoGroup.position.set(0, 1.6, videoZ);

	const planeGeometry = new THREE.PlaneGeometry(videoWidth, videoHeight);
	const planeMaterial = new THREE.MeshBasicMaterial({
		color: 0x111111,
		visible: false,
		side: THREE.DoubleSide,
	});
	videoPlaneMesh = new THREE.Mesh(planeGeometry, planeMaterial);
	videoPlaneMesh.name = 'videoPlane';
	videoGroup.add(videoPlaneMesh);

	videoElement = document.createElement('video');
	videoElement.src = VIDEO_MP4_URL;
	videoElement.loop = true;
	videoElement.muted = true;
	videoElement.playsInline = true;
	const videoTexture = new THREE.VideoTexture(videoElement);
	videoTexture.colorSpace = THREE.SRGBColorSpace;
	videoTexture.minFilter = THREE.LinearFilter;
	videoTexture.magFilter = THREE.LinearFilter;
	videoTexturePlane = new THREE.Mesh(
		planeGeometry.clone(),
		new THREE.MeshBasicMaterial({
			map: videoTexture,
			side: THREE.DoubleSide,
		}),
	);
	videoTexturePlane.renderOrder = 1;
	videoGroup.add(videoTexturePlane);

	const playPauseTex = createPlayPauseTexture();
	playPauseTex.update(true); // iniziale: play (video in pausa)
	const iconSize = 0.5;
	const iconGeometry = new THREE.PlaneGeometry(iconSize, iconSize);
	playPauseIconMesh = new THREE.Mesh(
		iconGeometry,
		new THREE.MeshBasicMaterial({
			map: playPauseTex.texture,
			side: THREE.DoubleSide,
			transparent: true,
			opacity: 0.9,
		}),
	);
	playPauseIconMesh.name = 'playPauseButton';
	playPauseIconMesh.position.y = -videoHeight / 2 - iconSize / 2 - 0.15;
	playPauseIconMesh.renderOrder = 2;
	videoGroup.add(playPauseIconMesh);

	videoElement.addEventListener('play', () => playPauseTex.update(false));
	videoElement.addEventListener('pause', () => playPauseTex.update(true));

	scene.add(videoGroup);

	// Puntatore al centro (crosshair) - nascosto in VR
	pointerElRef = document.createElement('div');
	pointerElRef.style.cssText = `
		position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
		width: 24px; height: 24px; pointer-events: none; z-index: 100;
		border: 2px solid rgba(255,255,255,0.8); border-radius: 50%;
		box-shadow: 0 0 0 2px rgba(0,0,0,0.5);
	`;
	document.body.appendChild(pointerElRef);

	function checkVideoClickAndPlay(clientX, clientY) {
		pointerCoords.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
		raycaster.setFromCamera(pointerCoords, camera);
		const iconHits = raycaster.intersectObject(playPauseIconMesh, true);
		if (iconHits.length > 0 && videoElement) {
			if (videoElement.paused) videoElement.play().catch(() => {});
			else videoElement.pause();
			return;
		}
		const hits = raycaster.intersectObject(videoPlaneMesh, true);
		if (hits.length > 0 && videoElement) {
			videoElement.play().catch(() => {});
		}
	}

	renderer.domElement.addEventListener('click', (e) => {
		checkVideoClickAndPlay(e.clientX, e.clientY);
	});

	// Giroscopio DeviceMotion (mobile, richiede permesso su iOS)
	if (typeof DeviceMotionEvent !== 'undefined') {
		const onMotion = (e) => {
			if (e.rotationRate) {
				gyroRate.alpha = e.rotationRate.alpha ?? 0;
				gyroRate.beta = e.rotationRate.beta ?? 0;
				gyroRate.gamma = e.rotationRate.gamma ?? 0;
			}
		};
		if (typeof DeviceMotionEvent.requestPermission === 'function') {
			window.requestGyroPermission = () => {
				DeviceMotionEvent.requestPermission()
					.then((p) => p === 'granted' && window.addEventListener('devicemotion', onMotion))
					.catch(console.warn);
			};
		} else {
			window.addEventListener('devicemotion', onMotion);
		}
	}

	const gltfLoader = new GLTFLoader();

	gltfLoader.load('assets/parco-scena.glb', (gltf) => {
		scene.add(gltf.scene);
	});

	gltfLoader.load('assets/blaster.glb', (gltf) => {
		blasterGroup.add(gltf.scene);
	});

	gltfLoader.load('assets/target.glb', (gltf) => {
		for (let i = 0; i < 3; i++) {
			const target = gltf.scene.clone();
			target.position.set(
				Math.random() * 10 - 5,
				i * 2 + 1,
				-Math.random() * 5 - 5,
			);
			scene.add(target);
			targets.push(target);
		}
	});

	scene.add(scoreText);
	scoreText.position.set(0, 0.67, -1.44);
	scoreText.rotateX(-Math.PI / 3.3);
	updateScoreDisplay();

	// Load and set up positional audio
	const listener = new THREE.AudioListener();
	camera.add(listener);

	const audioLoader = new THREE.AudioLoader();
	laserSound = new THREE.PositionalAudio(listener);
	audioLoader.load('assets/laser.ogg', (buffer) => {
		laserSound.setBuffer(buffer);
		blasterGroup.add(laserSound);
	});

	scoreSound = new THREE.PositionalAudio(listener);
	audioLoader.load('assets/score.ogg', (buffer) => {
		scoreSound.setBuffer(buffer);
		scoreText.add(scoreSound);
	});
}

function onFrame(
	delta,
	time,
	{ scene, camera, renderer, player, controllers },
) {
	// In VR nascondi puntatore
	if (pointerElRef) pointerElRef.style.display = renderer.xr.isPresenting ? 'none' : '';

	// Riferimento posizione/quaternion (camera o controller) per VR init e blaster
	const refPos = new THREE.Vector3();
	let refQuat = null;
	if (controllers.right) {
		controllers.right.raySpace.getWorldPosition(refPos);
		refQuat = controllers.right.raySpace.quaternion.clone();
	} else {
		camera.getWorldPosition(refPos);
		refQuat = camera.quaternion.clone();
	}
	const refVelocity = refPos
		.clone()
		.sub(liquidSphereInertia.prevPos)
		.divideScalar(Math.max(delta, 0.001));
	liquidSphereInertia.prevPos.copy(refPos);

	let angVelX = 0, angVelY = 0, angVelZ = 0;
	if (liquidSphereInertia.hasPrevQuat) {
		const dq = refQuat.clone().multiply(liquidSphereInertia.prevQuat.clone().invert());
		const euler = new THREE.Euler().setFromQuaternion(dq, 'YXZ');
		const dt = Math.max(delta, 0.001);
		angVelX = euler.x / dt;
		angVelY = euler.y / dt;
		angVelZ = euler.z / dt;
	}
	liquidSphereInertia.prevQuat.copy(refQuat);
	liquidSphereInertia.hasPrevQuat = true;

	const gs = liquidSphereInertia.gyroSensitivity;
	const gyroX = (gyroRate.gamma * Math.PI) / 180;
	const gyroY = (gyroRate.alpha * Math.PI) / 180;
	const gyroZ = (gyroRate.beta * Math.PI) / 180;

	const targetX = THREE.MathUtils.clamp(
		-refVelocity.x * liquidSphereInertia.sensitivity * 0.8 - angVelY * gs - gyroY * gs * 2,
		-liquidSphereInertia.maxTilt,
		liquidSphereInertia.maxTilt,
	);
	const targetY = THREE.MathUtils.clamp(
		-refVelocity.x * liquidSphereInertia.sensitivity - angVelZ * gs - gyroZ * gs * 2,
		-liquidSphereInertia.maxTilt,
		liquidSphereInertia.maxTilt,
	);
	const targetZ = THREE.MathUtils.clamp(
		refVelocity.z * liquidSphereInertia.sensitivity * 0.5 + angVelX * gs + gyroX * gs * 2,
		-liquidSphereInertia.maxTilt,
		liquidSphereInertia.maxTilt,
	);

	const d = liquidSphereInertia.damping * delta;
	const s = liquidSphereInertia.spring * delta;
	liquidSphereInertia.velX += (targetX - liquidSphereInertia.tiltX) * s - liquidSphereInertia.velX * d;
	liquidSphereInertia.velY += (targetY - liquidSphereInertia.tiltY) * s - liquidSphereInertia.velY * d;
	liquidSphereInertia.velZ += (targetZ - liquidSphereInertia.tiltZ) * s - liquidSphereInertia.velZ * d;
	liquidSphereInertia.tiltX += liquidSphereInertia.velX * delta;
	liquidSphereInertia.tiltY += liquidSphereInertia.velY * delta;
	liquidSphereInertia.tiltZ += liquidSphereInertia.velZ * delta;

	// Piani liquido: verso l'alto (giroscopio) + oscillazione da inerzia (simulazione liquido)
	camera.updateMatrixWorld(true);
	liquidMeshes.forEach(({ mesh, inertia }) => {
		mesh.parent.getWorldQuaternion(liquidParentWorldQuat);
		liquidInertiaEuler.set(
			liquidSphereInertia.tiltZ * inertia,
			liquidSphereInertia.tiltX * inertia,
			liquidSphereInertia.tiltY * inertia,
		);
		liquidInertiaQuat.setFromEuler(liquidInertiaEuler);
		mesh.quaternion
			.copy(liquidParentWorldQuat)
			.invert()
			.multiply(liquidBaseQuat)
			.multiply(liquidInertiaQuat);
	});

	if (controllers.right) {
		const { gamepad, raySpace, mesh } = controllers.right;
		if (!raySpace.children.includes(blasterGroup)) {
			raySpace.add(blasterGroup);
			mesh.visible = false;
			raySpace.getWorldPosition(blasterInertia.prevPos);
			raySpace.getWorldPosition(liquidSphereInertia.prevPos);
			liquidSphereInertia.prevQuat.copy(raySpace.quaternion);
		}

		// Oscillazione/inerzia del blaster in base al movimento orizzontale
		const currentPos = new THREE.Vector3();
		raySpace.getWorldPosition(currentPos);
		const velocity = currentPos.clone().sub(blasterInertia.prevPos).divideScalar(Math.max(delta, 0.001));
		blasterInertia.prevPos.copy(currentPos);

		const targetTiltY = THREE.MathUtils.clamp(
			-velocity.x * blasterInertia.sensitivity,
			-blasterInertia.maxTilt,
			blasterInertia.maxTilt,
		);
		const targetTiltZ = THREE.MathUtils.clamp(
			velocity.z * blasterInertia.sensitivity * 0.5,
			-blasterInertia.maxTilt,
			blasterInertia.maxTilt,
		);

		blasterInertia.tiltY += (targetTiltY - blasterInertia.tiltY) * Math.min(1, blasterInertia.damping * delta);
		blasterInertia.tiltZ += (targetTiltZ - blasterInertia.tiltZ) * Math.min(1, blasterInertia.damping * delta);

		blasterGroup.rotation.y = blasterInertia.tiltY;
		blasterGroup.rotation.z = blasterInertia.tiltZ;
		if (gamepad.getButtonClick(XR_BUTTONS.TRIGGER)) {
			const controllerDir = new THREE.Vector3(0, 0, -1).applyQuaternion(raySpace.quaternion);
			const controllerOrigin = new THREE.Vector3().setFromMatrixPosition(raySpace.matrixWorld);
			raycaster.set(controllerOrigin, controllerDir);
			const iconHits = raycaster.intersectObject(playPauseIconMesh, true);
			if (playPauseIconMesh && iconHits.length > 0 && videoElement) {
				if (videoElement.paused) videoElement.play().catch(() => {});
				else videoElement.pause();
			} else {
				const videoHits = raycaster.intersectObject(videoPlaneMesh, true);
				if (videoPlaneMesh && videoHits.length > 0 && videoElement) {
					videoElement.play().catch(() => {});
				} else {
					try {
						gamepad.getHapticActuator(0).pulse(0.6, 100);
					} catch {
						// do nothing
					}
					if (laserSound.isPlaying) laserSound.stop();
					laserSound.play();
					const bulletPrototype = blasterGroup.getObjectByName('bullet');
					if (bulletPrototype) {
						const bullet = bulletPrototype.clone();
						scene.add(bullet);
						bulletPrototype.getWorldPosition(bullet.position);
						bulletPrototype.getWorldQuaternion(bullet.quaternion);

						const directionVector = forwardVector
							.clone()
							.applyQuaternion(bullet.quaternion);
						bullet.userData = {
							velocity: directionVector.multiplyScalar(bulletSpeed),
							timeToLive: bulletTimeToLive,
						};
						bullets[bullet.uuid] = bullet;
					}
				}
			}
		}
	}

	Object.values(bullets).forEach((bullet) => {
		if (bullet.userData.timeToLive < 0) {
			delete bullets[bullet.uuid];
			scene.remove(bullet);
			return;
		}
		const deltaVec = bullet.userData.velocity.clone().multiplyScalar(delta);
		bullet.position.add(deltaVec);
		bullet.userData.timeToLive -= delta;

		targets
			.filter((target) => target.visible)
			.forEach((target) => {
				const distance = target.position.distanceTo(bullet.position);
				if (distance < 1) {
					delete bullets[bullet.uuid];
					scene.remove(bullet);

					gsap.to(target.scale, {
						duration: 0.3,
						x: 0,
						y: 0,
						z: 0,
						onComplete: () => {
							target.visible = false;
							setTimeout(() => {
								target.visible = true;
								target.position.x = Math.random() * 10 - 5;
								target.position.z = -Math.random() * 5 - 5;

								// Scale back up the target
								gsap.to(target.scale, {
									duration: 0.3,
									x: 1,
									y: 1,
									z: 1,
								});
							}, 1000);
						},
					});

					score += 10;
					updateScoreDisplay();
					if (scoreSound.isPlaying) scoreSound.stop();
					scoreSound.play();
				}
			});
	});
	gsap.ticker.tick(delta);
}

init(setupScene, onFrame);
