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

// Sfere con liquido finto (due occhi) - ruotano in senso opposto al movimento
const liquidSpheresContainer = new THREE.Group();
const liquidMeshes = []; // [{ mesh, inertia }, ...]
const liquidSphereInertia = {
	prevPos: new THREE.Vector3(),
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
};

let score = 0;
const scoreText = new Text();
scoreText.fontSize = 0.52;
scoreText.font = 'assets/SpaceMono-Bold.ttf';
scoreText.position.z = -2;
scoreText.color = 0xffa276;
scoreText.anchorX = 'center';
scoreText.anchorY = 'middle';

let laserSound, scoreSound;

function updateScoreDisplay() {
	const clampedScore = Math.max(0, Math.min(9999, score));
	const displayScore = clampedScore.toString().padStart(4, '0');
	scoreText.text = displayScore;
	scoreText.sync();
}

function setupScene({ scene, camera, renderer, player, controllers }) {
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
		liquidMesh.rotation.x = -Math.PI / 2;
		liquidMesh.renderOrder = 1;
		group.add(liquidMesh);
		liquidMeshes.push({ mesh: liquidMesh, inertia: inertias[i] });

		liquidSpheresContainer.add(group);
	}

	liquidSpheresContainer.position.set(0, 0, -1.2);
	liquidSpheresContainer.scale.setScalar(0.8);
	camera.add(liquidSpheresContainer);
	camera.getWorldPosition(liquidSphereInertia.prevPos);

	const gltfLoader = new GLTFLoader();

	gltfLoader.load('assets/spacestation.glb', (gltf) => {
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
	// Liquido: ruota in senso opposto allo spostamento, oscillazione quando ti fermi
	// In VR usa il controller (camera non aggiornata prima di onFrame), altrimenti la camera
	const refPos = new THREE.Vector3();
	if (controllers.right) {
		controllers.right.raySpace.getWorldPosition(refPos);
	} else {
		camera.getWorldPosition(refPos);
	}
	const refVelocity = refPos
		.clone()
		.sub(liquidSphereInertia.prevPos)
		.divideScalar(Math.max(delta, 0.001));
	liquidSphereInertia.prevPos.copy(refPos);

	const targetX = THREE.MathUtils.clamp(
		-refVelocity.x * liquidSphereInertia.sensitivity * 0.8,
		-liquidSphereInertia.maxTilt,
		liquidSphereInertia.maxTilt,
	);
	const targetY = THREE.MathUtils.clamp(
		-refVelocity.x * liquidSphereInertia.sensitivity,
		-liquidSphereInertia.maxTilt,
		liquidSphereInertia.maxTilt,
	);
	const targetZ = THREE.MathUtils.clamp(
		refVelocity.z * liquidSphereInertia.sensitivity * 0.5,
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

	liquidMeshes.forEach(({ mesh, inertia }) => {
		mesh.rotation.x = -Math.PI / 2 + liquidSphereInertia.tiltZ * inertia;
		mesh.rotation.y = liquidSphereInertia.tiltX * inertia;
		mesh.rotation.z = liquidSphereInertia.tiltY * inertia;
	});

	if (controllers.right) {
		const { gamepad, raySpace, mesh } = controllers.right;
		if (!raySpace.children.includes(blasterGroup)) {
			raySpace.add(blasterGroup);
			mesh.visible = false;
			raySpace.getWorldPosition(blasterInertia.prevPos);
			raySpace.getWorldPosition(liquidSphereInertia.prevPos);
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
			try {
				gamepad.getHapticActuator(0).pulse(0.6, 100);
			} catch {
				// do nothing
			}

			// Play laser sound
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
