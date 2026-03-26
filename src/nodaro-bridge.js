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

	var parentOrigin = null;

	function isAllowedOrigin(origin) {
		if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
		if (origin.indexOf('http://localhost:') === 0) return true;
		if (origin.indexOf('https://') === 0 && origin.indexOf('.up.railway.app') === origin.length - 15) return true;
		return false;
	}

	// --- Audio Loading ---

	function waitForEngine(callback) {
		var editor = window.PKAudioEditor;
		if (editor && editor.engine && editor.engine.wavesurfer) {
			callback();
		} else {
			setTimeout(function() { waitForEngine(callback); }, 100);
		}
	}

	function loadAudioBlob(blob) {
		waitForEngine(function() {
			var editor = window.PKAudioEditor;
			var ws = editor.engine.wavesurfer;
			// Reset add mode so it opens as new, not appends
			ws.backend._add = 0;
			editor.engine.is_ready = false;
			editor.fireEvent('WillDownloadFile');
			ws.loadBlob(blob);
			editor.fireEvent('DidUnloadFile');
			if (ws.regions) ws.regions.clear();
		});
	}

	function handleMessage(event) {
		if (!isAllowedOrigin(event.origin)) return;
		if (!parentOrigin) parentOrigin = event.origin;

		var data = event.data;
		if (!data || !data.type) return;

		if (data.type === 'NODARO_LOAD_AUDIO') {
			var payload = data.payload || {};
			if (payload.audioBuffer) {
				// ArrayBuffer transferred via postMessage
				var blob = new Blob([payload.audioBuffer], { type: 'audio/mpeg' });
				loadAudioBlob(blob);
			} else if (payload.audioUrl) {
				// URL fallback -- fetch then load
				fetch(payload.audioUrl)
					.then(function(res) { return res.blob(); })
					.then(function(blob) { loadAudioBlob(blob); })
					.catch(function(err) {
						// ignore -- user will see empty editor
					});
			}
		}
	}

	// --- Export Intercept ---
	//
	// AudioMass export flow (actions.js lines 808-929):
	//   1. Web Worker encodes audio (MP3/WAV/FLAC)
	//   2. Worker posts back a Blob via onmessage
	//   3. forceDownload(blob) creates an <a> element, sets href to objectURL, calls a.click()
	//   4. callback('done') fires, which triggers 'DidDownloadFile' event
	//
	// Strategy: We monkey-patch URL.createObjectURL to capture the blob when it is an
	// audio blob created during export. We also suppress the <a>.click() download and
	// instead send the blob to the parent via postMessage.

	var _origCreateObjectURL = URL.createObjectURL.bind(URL);
	var _exportInterceptActive = false;
	var _capturedBlob = null;
	var _capturedUrl = null;
	var _lastExportFilename = null;

	URL.createObjectURL = function(obj) {
		var url = _origCreateObjectURL(obj);
		if (_exportInterceptActive && obj instanceof Blob && obj.size > 0) {
			// Capture this blob -- it is the encoded audio from the worker
			_capturedBlob = obj;
			_capturedUrl = url;
		}
		return url;
	};

	// Intercept <a> element click to prevent browser download during export
	var _origCreateElement = document.createElement.bind(document);
	document.createElement = function(tagName) {
		var el = _origCreateElement(tagName);
		if (_exportInterceptActive && tagName.toLowerCase() === 'a') {
			// Override click() on this specific anchor to intercept the download
			var _origClick = el.click.bind(el);
			el.click = function() {
				if (_exportInterceptActive && el.download && _capturedBlob) {
					// We have the blob. Send it to parent instead of downloading.
					_lastExportFilename = el.download;
					sendExportToParent(_capturedBlob, el.download);
					// Clean up the object URL
					URL.revokeObjectURL(el.href);
					_capturedBlob = null;
					_capturedUrl = null;
					_exportInterceptActive = false;
					return;
				}
				_origClick();
			};
		}
		return el;
	};

	function sendExportToParent(blob, filename) {
		var reader = new FileReader();
		reader.onload = function() {
			var buffer = reader.result;
			var mimeType = blob.type || getMimeFromFilename(filename);
			var targetOrigin = parentOrigin || '*';
			window.parent.postMessage(
				{
					type: 'AUDIOMASS_EXPORT_COMPLETE',
					payload: {
						audioBuffer: buffer,
						mimeType: mimeType,
						filename: filename
					}
				},
				targetOrigin,
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
		return 'audio/wav';
	}

	function interceptExport() {
		var editor = window.PKAudioEditor;
		if (!editor) return;

		// Listen for export start to activate intercept mode
		editor.listenFor('WillDownloadFile', function() {
			// Only activate if this is an actual export (not a file load).
			// We detect export vs load by checking if is_ready is true
			// (loads set is_ready=false before firing WillDownloadFile,
			// exports only fire WillDownloadFile when is_ready is already true).
			if (editor.engine && editor.engine.is_ready) {
				_exportInterceptActive = true;
				_capturedBlob = null;
				_capturedUrl = null;
			}
		});

		// Safety: if export ends without us capturing, reset state
		editor.listenFor('DidDownloadFile', function() {
			_exportInterceptActive = false;
			_capturedBlob = null;
			_capturedUrl = null;
		});
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
				interceptExport();
				// Signal parent that we are ready
				var targetOrigin = parentOrigin || '*';
				window.parent.postMessage({ type: 'AUDIOMASS_READY' }, targetOrigin);
			});
		} else {
			setTimeout(onAppReady, 50);
		}
	}
	onAppReady();
})();
