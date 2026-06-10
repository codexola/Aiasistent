(function () {
  if (window.__aiMeetingAudioBridge) return;

  const state = {
    audioContext: null,
    micStream: null,
    tabStream: null,
    mixerDestination: null,
    micGain: null,
    tabGain: null,
    ttsGain: null,
    mixedStream: null,
    ready: false,
    muteMicDuringSpeak: true
  };

  function getContext() {
    if (!state.audioContext) {
      state.audioContext = new AudioContext({ latencyHint: 'interactive' });
    }
    return state.audioContext;
  }

  function buildMixedStream(micStream, tabStream) {
    const ctx = getContext();
    state.micStream = micStream;
    state.tabStream = tabStream;
    state.mixerDestination = ctx.createMediaStreamDestination();

    state.micGain = ctx.createGain();
    state.micGain.gain.value = 1;
    const micSource = ctx.createMediaStreamSource(micStream);
    micSource.connect(state.micGain);
    state.micGain.connect(state.mixerDestination);

    state.tabGain = ctx.createGain();
    state.tabGain.gain.value = 0;
    if (tabStream?.getAudioTracks().length) {
      try {
        const tabSource = ctx.createMediaStreamSource(tabStream);
        tabSource.connect(state.tabGain);
        state.tabGain.connect(state.mixerDestination);
      } catch {
        /* tab audio kept at zero on uplink to prevent client echo */
      }
    }

    state.ttsGain = ctx.createGain();
    state.ttsGain.gain.value = 1;
    state.ttsGain.connect(state.mixerDestination);

    state.mixedStream = state.mixerDestination.stream;
    state.ready = true;
    return state.mixedStream;
  }

  function mixedAudioTrack() {
    return state.mixedStream?.getAudioTracks()[0] || null;
  }

  function replaceAudioTrackInPeerConnection(pc) {
    const track = mixedAudioTrack();
    if (!track) return;
    pc.getSenders().forEach((sender) => {
      if (sender.track?.kind === 'audio') {
        sender.replaceTrack(track).catch(() => {});
      }
    });
  }

  function wrapPeerConnection(pc) {
    const origAddTrack = pc.addTrack.bind(pc);
    pc.addTrack = function (track, ...rest) {
      if (track?.kind === 'audio') {
        const mixed = mixedAudioTrack();
        if (mixed) track = mixed;
      }
      return origAddTrack(track, ...rest);
    };

    const origReplaceTrack = pc.replaceTrack?.bind(pc);
    if (origReplaceTrack) {
      pc.replaceTrack = function (sender, track) {
        if (track?.kind === 'audio') {
          const mixed = mixedAudioTrack();
          if (mixed) track = mixed;
        }
        return origReplaceTrack(sender, track);
      };
    }

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected') replaceAudioTrackInPeerConnection(pc);
    });

    setTimeout(() => replaceAudioTrackInPeerConnection(pc), 500);
    setTimeout(() => replaceAudioTrackInPeerConnection(pc), 2000);
  }

  const OrigPeerConnection = window.RTCPeerConnection;
  if (OrigPeerConnection) {
    window.RTCPeerConnection = function (...args) {
      const pc = new OrigPeerConnection(...args);
      wrapPeerConnection(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = OrigPeerConnection.prototype;
  }

  const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await origGetUserMedia(constraints);
    if (!constraints?.audio) return stream;

    if (!state.micStream) {
      buildMixedStream(stream, state.tabStream);
    }

    const mixed = mixedAudioTrack();
    if (!mixed) return stream;

    const out = new MediaStream([mixed, ...stream.getVideoTracks()]);
    patchAllPeerConnections();
    return out;
  };

  function patchAllPeerConnections() {
    /* Peer connections are wrapped at creation; re-patch senders on existing PCs if accessible */
  }

  async function injectTTS(arrayBuffer) {
    const ctx = getContext();
    if (ctx.state === 'suspended') await ctx.resume();

    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;

    if (state.muteMicDuringSpeak && state.micGain) {
      state.micGain.gain.setValueAtTime(0.02, ctx.currentTime);
    }

    source.connect(state.ttsGain);

    return new Promise((resolve, reject) => {
      source.onended = () => {
        if (state.micGain) {
          state.micGain.gain.setValueAtTime(1, ctx.currentTime);
        }
        resolve();
      };
      source.onerror = reject;
      source.start(0);
    });
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  window.__aiMeetingAudioBridge = {
    isReady: () => state.ready,
    injectTTS,
    setTabStream(stream) {
      state.tabStream = stream;
      if (state.micStream && !state.ready) {
        buildMixedStream(state.micStream, stream);
      }
    },
    setMuteMicDuringSpeak(value) {
      state.muteMicDuringSpeak = value !== false;
    },
    async ensureContext() {
      const ctx = getContext();
      if (ctx.state === 'suspended') await ctx.resume();
    }
  };

  window.addEventListener('ai-meeting-tts-request', async (event) => {
    try {
      const { audioBase64 } = event.detail || {};
      if (!audioBase64) return;
      await window.__aiMeetingAudioBridge.ensureContext();
      const buffer = base64ToArrayBuffer(audioBase64);
      await injectTTS(buffer);
      window.dispatchEvent(new CustomEvent('ai-meeting-tts-done', { detail: { ok: true } }));
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent('ai-meeting-tts-done', { detail: { ok: false, error: err.message } })
      );
    }
  });

  window.addEventListener('ai-meeting-config', (event) => {
    window.__aiMeetingAudioBridge?.setMuteMicDuringSpeak(event.detail?.muteMicDuringSpeak);
  });

  window.addEventListener('ai-meeting-set-tab-stream', (event) => {
    const { streamId } = event.detail || {};
    if (!streamId) return;
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId
          }
        }
      })
      .then((stream) => {
        window.__aiMeetingAudioBridge.setTabStream(stream);
        window.dispatchEvent(new CustomEvent('ai-meeting-tab-audio-ready'));
      })
      .catch(() => {});
  });

  window.dispatchEvent(new CustomEvent('ai-audio-bridge-ready'));
})();
