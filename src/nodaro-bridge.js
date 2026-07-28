(function() {
	'use strict';

	// Only activate when embedded in an iframe
	var isEmbedded = false;
	try { isEmbedded = window.self !== window.top; } catch(e) { isEmbedded = true; }
	if (!isEmbedded) return;

	var ALLOWED_ORIGINS = [
		'https://app.nodaro.ai',
		'https://next.nodaro.ai'
	];
	var RAILWAY_SUFFIX = '.up.railway.app';
	var SESSION_MIME = 'application/x-audiomass-session';

	function isAllowedOrigin(origin) {
		if (!origin) return false;
		if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
		if (origin.indexOf('http://localhost:') === 0) return true;
		if (origin.indexOf('http://127.0.0.1:') === 0) return true;
		if (origin.indexOf('https://') === 0 &&
		    origin.length > RAILWAY_SUFFIX.length &&
		    origin.slice(-RAILWAY_SUFFIX.length) === RAILWAY_SUFFIX) return true;
		return false;
	}

	// Seeded from the referrer so an export never has to be posted to '*'.
	// Replaced by the first valid inbound message from the parent.
	var parentOrigin = null;
	try {
		if (document.referrer) {
			var refOrigin = new URL(document.referrer).origin;
			if (isAllowedOrigin(refOrigin)) parentOrigin = refOrigin;
		}
	} catch(e) {}

	// --- Audio Loading ---

	function waitForEngine(callback) {
		var editor = window.PKAudioEditor;
		if (editor && editor.engine && editor.engine.wavesurfer) {
			callback();
		} else {
			setTimeout(function() { waitForEngine(callback); }, 100);
		}
	}

	// WillDownloadFile raises an opaque full-screen loader (ui.js) that is only
	// taken down by DidDownloadFile. engine.js fires DidDownloadFile from its
	// wavesurfer 'ready' handler, but behind an `if (q.is_ready) return` guard --
	// so clearing is_ready before loading, as we do below, is a race against the
	// app's own initialisation. Lose it and the loader never lifts: the editor
	// renders as a blank sheet even though the audio decoded fine.
	//
	// DidReadyFire is fired unconditionally at the top of that same handler, so
	// use it to guarantee the loader comes down. Firing DidDownloadFile twice is
	// harmless; ui.js just removes a class.
	// The parent creates the iframe and posts audio as soon as we say READY, which
	// is routinely before the browser has laid the iframe out -- window.innerWidth
	// is still 0 at that point. wavesurfer sizes its canvas from the container, so
	// it draws the waveform 0px wide and the editor looks empty even though the
	// audio decoded fine.
	//
	// The drawer caches that zero in drawer.width, and because AudioMass runs
	// wavesurfer with fillParent/scrollParent off, the wrapper keeps an explicit
	// 0px width forever after. Nothing recovers it on its own: RequestResize only
	// calls setHeight, drawBuffer() re-reads the cached width, and even a fresh
	// loadBlob draws into the same poisoned drawer. drawer.setWidth() is the one
	// call that re-measures -- it early-returns unless the value actually changes,
	// so feed it the container's real width and then redraw.
	function redraw(editor) {
		if (!editor || !editor.engine) return;
		var ws = editor.engine.wavesurfer;
		var dr = ws && ws.drawer;
		if (!dr || !dr.container) return;
		try {
			var want = dr.container.clientWidth * (ws.params && ws.params.pixelRatio || 1);
			if (want > 0 && dr.width !== want && dr.setWidth) dr.setWidth(want);
		} catch(e) {}
		try { editor.fireEvent('RequestResize'); } catch(e) {}
		try { if (ws.drawBuffer) ws.drawBuffer(); } catch(e) {}
	}

	function redrawWhenLaidOut(editor) {
		var tries = 0;
		(function settle() {
			// Bail out after ~2s of frames so a genuinely hidden iframe cannot
			// spin here forever.
			if (window.innerWidth > 0 || ++tries > 120) { redraw(editor); return; }
			requestAnimationFrame(settle);
		})();
		// Second pass for layout that settles after the first paint.
		setTimeout(function() { redraw(editor); }, 350);
	}

	var readyGuardInstalled = false;
	function installLoaderGuard(editor) {
		if (readyGuardInstalled) return;
		readyGuardInstalled = true;

		editor.listenFor('DidReadyFire', function() {
			editor.fireEvent('DidDownloadFile');
			redrawWhenLaidOut(editor);
		});

		// The iframe going from unlaid-out to laid-out does not always surface as
		// a resize event, so watch the element itself where we can.
		if (typeof ResizeObserver === 'function') {
			try {
				var ro = new ResizeObserver(function() { redraw(window.PKAudioEditor); });
				ro.observe(document.body);
			} catch(e) {}
		}
		window.addEventListener('resize', function() { redraw(window.PKAudioEditor); });
	}

	function reportLoadFailure(reason, detail) {
		if (!parentOrigin) return;
		window.parent.postMessage({
			type: 'AUDIOMASS_LOAD_ERROR',
			payload: { reason: reason, detail: String(detail || '') }
		}, parentOrigin);
	}

	function loadAudioBlob(blob) {
		waitForEngine(function() {
			var editor = window.PKAudioEditor;
			var ws = editor.engine.wavesurfer;
			installLoaderGuard(editor);

			// A cross-origin iframe with no user activation gets a suspended
			// AudioContext, and wavesurfer's decode never resolves against one --
			// no 'ready', so the loader would sit there forever. Resume first.
			try {
				var ac = ws.backend && ws.backend.ac;
				if (ac && ac.state === 'suspended' && ac.resume) ac.resume();
			} catch(e) {}

			// Nothing below may throw silently: a failure here leaves the editor
			// showing the loading overlay with no audio, which reads as "the
			// editor opened blank". Tell the parent instead.
			var settled = false;
			editor.listenFor('DidReadyFire', function() { settled = true; });
			setTimeout(function() {
				if (!settled) reportLoadFailure('decode-timeout', ws.backend && ws.backend.ac && ws.backend.ac.state);
			}, 20000);

			try {
				// Reset add mode so it opens as new, not appends
				ws.backend._add = 0;
				editor.engine.is_ready = false;
				editor.fireEvent('WillDownloadFile');
				ws.loadBlob(blob);
				editor.fireEvent('DidUnloadFile');
				if (ws.regions) ws.regions.clear();
			} catch (err) {
				editor.fireEvent('DidDownloadFile');
				reportLoadFailure('exception', err && err.message);
			}
		});
	}

	function handleMessage(event) {
		if (!isAllowedOrigin(event.origin)) return;
		parentOrigin = event.origin;

		var data = event.data;
		if (!data || !data.type) return;

		// On-demand state snapshot. The editor is cross-origin to the platform,
		// so when it misbehaves inside the iframe there is otherwise no way to
		// see what it looks like from the outside.
		if (data.type === 'NODARO_DIAGNOSTICS') {
			var snap = {};
			try {
				var ed = window.PKAudioEditor;
				var wsd = ed && ed.engine && ed.engine.wavesurfer;
				var app = document.getElementById('app');
				var cvs = document.getElementsByTagName('canvas');
				snap = {
					readyState: document.readyState,
					appChildren: app ? app.children.length : -1,
					innerWH: window.innerWidth + 'x' + window.innerHeight,
					duration: wsd && wsd.getDuration ? wsd.getDuration() : null,
					wsHeight: wsd && wsd.params ? wsd.params.height : null,
					canvasCount: cvs.length,
					canvasSizes: Array.prototype.slice.call(cvs, 0, 4).map(function(c) {
						var r = c.getBoundingClientRect();
						return c.width + 'x' + c.height + '@' + Math.round(r.width) + 'x' + Math.round(r.height);
					}),
					acState: wsd && wsd.backend && wsd.backend.ac ? wsd.backend.ac.state : null,
					isReady: ed && ed.engine ? ed.engine.is_ready : null,
					activeOverlays: Array.prototype.filter.call(document.querySelectorAll('*'), function(e) {
						return String(e.className || '').indexOf('pk_act') !== -1;
					}).map(function(e) { return e.className; }),
					bodyText: (document.body.innerText || '').slice(0, 120)
				};
			} catch (e) { snap = { snapshotError: String(e && e.message) }; }
			window.parent.postMessage({ type: 'AUDIOMASS_DIAGNOSTICS', payload: snap }, parentOrigin || event.origin);
			return;
		}

		if (data.type === 'NODARO_LOAD_AUDIO') {
			var payload = data.payload || {};
			if (payload.audioBuffer) {
				// ArrayBuffer transferred via postMessage
				var blob = new Blob([payload.audioBuffer], { type: payload.mimeType || 'audio/mpeg' });
				loadAudioBlob(blob);
			} else if (payload.audioUrl) {
				// URL fallback -- fetch then load
				fetch(payload.audioUrl)
					.then(function(res) { return res.blob(); })
					.then(function(blob) { loadAudioBlob(blob); })
					.catch(function() {
						// ignore -- user will see empty editor
					});
			}
		}
	}

	// --- Export Intercept ---
	//
	// Every AudioMass download ends the same way, regardless of which feature
	// produced it: a Blob is wrapped with URL.createObjectURL, assigned to a
	// hidden <a download>, and clicked.
	//   - mp3/wav/flac export  -> actions.js forceDownload()
	//   - multitrack mixdown   -> same path via AudioUtils.DownloadFile
	//   - session save (.amss) -> amss-format.js
	//
	// So we register every blob: URL handed out and intercept the anchor click,
	// routing audio blobs to the parent instead of to the filesystem. Session
	// files (.amss) are left alone -- those are a real user download.
	//
	// This is deliberately NOT gated on AudioMass' WillDownloadFile event: that
	// event fires for file *loads* too (engine.js fires it before clearing
	// is_ready), so any event-armed window is both leaky and dependent on
	// upstream statement ordering that has already changed once.

	var blobRegistry = new Map();
	var MAX_REGISTRY = 32;

	function patchObjectURL(target) {
		if (!target || typeof target.createObjectURL !== 'function') return;
		var origCreate = target.createObjectURL.bind(target);
		var origRevoke = target.revokeObjectURL.bind(target);
		target.createObjectURL = function(obj) {
			var url = origCreate(obj);
			if (obj instanceof Blob) {
				blobRegistry.set(url, obj);
				// Bounded: AudioMass does not revoke every URL it creates.
				while (blobRegistry.size > MAX_REGISTRY) {
					blobRegistry.delete(blobRegistry.keys().next().value);
				}
			}
			return url;
		};
		target.revokeObjectURL = function(url) {
			blobRegistry.delete(url);
			return origRevoke(url);
		};
	}
	patchObjectURL(window.URL);
	if (window.webkitURL && window.webkitURL !== window.URL) patchObjectURL(window.webkitURL);

	function isSessionDownload(blob, filename) {
		if (blob && blob.type === SESSION_MIME) return true;
		return /\.amss$/i.test(filename || '');
	}

	function handleAnchorClick(el, nativeClick) {
		var filename = el.download || '';
		var href = el.href || '';

		// Not a blob download -- ordinary link, leave it alone.
		if (!filename || href.indexOf('blob:') !== 0) { nativeClick(); return; }

		var blob = blobRegistry.get(href);
		if (blob) {
			if (isSessionDownload(blob, filename)) nativeClick();
			else sendExportToParent(blob, filename, nativeClick);
			return;
		}

		// Fallback: a blob: URL stays resolvable even if we missed its creation.
		// Suppress the click now and decide once we have the bytes.
		fetch(href)
			.then(function(res) { return res.blob(); })
			.then(function(b) {
				if (isSessionDownload(b, filename)) nativeClick();
				else sendExportToParent(b, filename, nativeClick);
			})
			.catch(function() { nativeClick(); });
	}

	var origCreateElement = document.createElement.bind(document);
	document.createElement = function(tagName) {
		var el = origCreateElement.apply(null, arguments);
		if (String(tagName).toLowerCase() === 'a') {
			var nativeClick = el.click.bind(el);
			el.click = function() { handleAnchorClick(el, nativeClick); };
		}
		return el;
	};

	function sendExportToParent(blob, filename, nativeClick) {
		// Never post user audio to '*'. If we somehow have no verified parent,
		// fall back to a real download so the user does not lose the export.
		if (!parentOrigin) { nativeClick && nativeClick(); return; }

		var reader = new FileReader();
		reader.onerror = function() { nativeClick && nativeClick(); };
		reader.onload = function() {
			var buffer = reader.result;
			window.parent.postMessage(
				{
					type: 'AUDIOMASS_EXPORT_COMPLETE',
					payload: {
						audioBuffer: buffer,
						mimeType: blob.type || getMimeFromFilename(filename),
						filename: filename
					}
				},
				parentOrigin,
				[buffer]
			);
		};
		reader.readAsArrayBuffer(blob);
	}

	function getMimeFromFilename(name) {
		if (!name) return 'audio/wav';
		var ext = name.split('.').pop().toLowerCase();
		if (ext === 'mp3') return 'audio/mpeg';
		if (ext === 'flac') return 'audio/flac';
		if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
		if (ext === 'aac') return 'audio/aac';
		if (ext === 'ogg') return 'audio/ogg';
		return 'audio/wav';
	}

	// --- Welcome Screen Suppression ---
	//
	// welcome.js uses setTimeout(fn, 320) to register _deps.Wlc and call it.
	// Our script runs synchronously before that timeout fires, so we use
	// Object.defineProperty to make _deps.Wlc a no-op that ignores writes.
	// This guarantees the welcome modal never appears when embedded.

	function suppressWelcome() {
		var editor = window.PKAudioEditor;
		if (editor && editor._deps) {
			// Use defineProperty so welcome.js cannot overwrite our no-op
			Object.defineProperty(editor._deps, 'Wlc', {
				get: function() { return function() {}; },
				set: function() { /* silently ignore writes from welcome.js */ },
				configurable: true
			});
			// Also set localStorage flag as a belt-and-suspenders measure
			try { window.localStorage.setItem('k', '1'); } catch(e) {}
		}
	}

	// --- Initialization ---

	window.addEventListener('message', handleMessage);

	function onAppReady() {
		var editor = window.PKAudioEditor;
		if (editor && editor._deps) {
			suppressWelcome();
			// Wait for engine to be initialized (happens during editor.init())
			waitForEngine(function() {
				// READY carries no user data, so '*' is acceptable when the
				// referrer was stripped; the parent validates our origin anyway.
				window.parent.postMessage({ type: 'AUDIOMASS_READY' }, parentOrigin || '*');
			});
		} else {
			setTimeout(onAppReady, 50);
		}
	}
	onAppReady();
})();
