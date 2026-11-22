import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib
import sys
from queue import Queue, Empty as QueueEmpty, Full as QueueFull
import threading
import json
import os
import time

MULTI_LANGUAGE_CODE = "multi"
AUTO_LANGUAGE_CODES = {"auto", "automatic", "detect"}
DEFAULT_MODEL = "nova-3-medical"

audio_queue = Queue(maxsize=200)
stop_event = threading.Event()
restart_event = threading.Event()
state_lock = threading.Lock()

model_name = sys.argv[6] if len(sys.argv) > 6 else DEFAULT_MODEL
language_code = sys.argv[7] if len(sys.argv) > 7 else MULTI_LANGUAGE_CODE

Gst.init(None)

pipeline_str = """
rtpbin name=rtpbin latency=10 buffer-mode=0
udpsrc port={audio_remote_rtp_port} caps="{audio_caps}" ! rtpbin.recv_rtp_sink_0 rtpbin. ! rtpopusdepay ! opusdec plc=false ! queue max-size-buffers=20 max-size-time=0 max-size-bytes=0 leaky=downstream ! audioconvert ! audioresample ! audio/x-raw, format=S16LE, rate=16000, channels=1 ! appsink name=audio_sink emit-signals=true sync=false max-buffers=20 drop=true
udpsrc address=127.0.0.1 port={audio_remote_rtcp_port} ! rtpbin.recv_rtcp_sink_0 rtpbin.send_rtcp_src_0 ! udpsink host=127.0.0.1 port={audio_local_rtcp_port} bind-address=127.0.0.1 bind-port={audio_remote_rtcp_port} sync=false async=false
"""

pipeline_str = pipeline_str.format(
    audio_remote_rtp_port=sys.argv[1],
    audio_caps=f"application/x-rtp, media=(string)audio, encoding-name=(string)OPUS, clock-rate=(int)48000, payload=(int){sys.argv[4]}, ssrc=(uint){sys.argv[5]}",
    audio_remote_rtcp_port=sys.argv[2],
    audio_local_rtcp_port=sys.argv[3]
)

pipeline = Gst.parse_launch(pipeline_str)
appsink = pipeline.get_by_name("audio_sink")


# Drops the oldest frame when Deepgram is slower than the call.
def enqueue_audio(data):
    try:
        audio_queue.put_nowait(data)
    except QueueFull:
        try:
            audio_queue.get_nowait()
            audio_queue.put_nowait(data)
        except Exception:
            pass


def on_new_sample(sink):
    sample = sink.emit("pull-sample")
    buf = sample.get_buffer()
    enqueue_audio(buf.extract_dup(0, buf.get_size()))
    return Gst.FlowReturn.OK


appsink.connect("new-sample", on_new_sample)


def normalize_language(code):
    normalized = str(code or "").strip()
    if normalized.lower() in AUTO_LANGUAGE_CODES:
        return MULTI_LANGUAGE_CODE
    return normalized or MULTI_LANGUAGE_CODE


def get_value(value, key, default=None):
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def first_item(value):
    if isinstance(value, list) and value:
        return value[0]
    return value


def get_first_alternative(message):
    channel = first_item(get_value(message, "channel"))
    alternatives = get_value(channel, "alternatives") or []
    if not alternatives:
        return None
    return first_item(alternatives)


# Streaming results carry language on the alternative and on each word; the
# pre-recorded `detected_language` field is never present here.
def detect_message_language(alt):
    languages = get_value(alt, "languages")
    if languages:
        best = None
        best_confidence = -1
        for item in languages:
            if isinstance(item, str):
                return item.strip().lower()
            language = get_value(item, "language")
            confidence = get_value(item, "confidence", 0)
            if language and confidence >= best_confidence:
                best = language
                best_confidence = confidence
        if best:
            return str(best).strip().lower()
    words = get_value(alt, "words")
    if words:
        counts = {}
        for word in words:
            value = get_value(word, "language")
            if value:
                key = str(value).strip().lower()
                counts[key] = counts.get(key, 0) + 1
        if counts:
            return max(counts, key=counts.get)
    return ""


def emit_transcript(is_final, text, language):
    payload = {"isFinal": bool(is_final), "text": text}
    if language:
        payload["language"] = language
    print(json.dumps(payload), flush=True)


def drain_queue():
    while True:
        try:
            audio_queue.get_nowait()
        except QueueEmpty:
            break


# A language change needs a new Deepgram socket, so it drops the old one.
def listen_for_commands():
    global model_name, language_code
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            if message.get("type") != "CHANGE_LANG":
                continue
            with state_lock:
                language_code = normalize_language(message.get("language"))
                model_name = str(message.get("model") or DEFAULT_MODEL).strip() or DEFAULT_MODEL
            drain_queue()
            restart_event.set()
        except Exception as error:
            print(f"Invalid control message: {error}", file=sys.stderr, flush=True)


def deepgram_stt_stream():
    try:
        from deepgram import DeepgramClient
        from deepgram.core.events import EventType
        from deepgram.extensions.types.sockets import ListenV1ControlMessage
    except ImportError:
        print("Failed to import Deepgram. Please run: pip install deepgram-sdk", file=sys.stderr, flush=True)
        return

    if os.getenv("DEEPGRAM_API_KEY") is None:
        print("DEEPGRAM_API_KEY environment variable not set. Exiting.", file=sys.stderr, flush=True)
        return

    while not stop_event.is_set():
        restart_event.clear()
        connection_closed = threading.Event()
        sender_done = threading.Event()
        sender_thread = None
        buffer = ""
        finals_accumulated = 0

        try:
            with state_lock:
                cycle_language = normalize_language(language_code)
                cycle_model = model_name
            is_multi = cycle_language.lower() == MULTI_LANGUAGE_CODE

            options = {
                "model": cycle_model,
                "encoding": "linear16",
                "sample_rate": "16000",
                "interim_results": True,
                "language": cycle_language,
                "endpointing": 100,
                "utterance_end_ms": "1000",
                "punctuate": True,
                "smart_format": False,
            }

            deepgram = DeepgramClient()
            print(f"Deepgram {cycle_model} language={cycle_language}", file=sys.stderr, flush=True)

            with deepgram.listen.v1.connect(**options) as connection:
                def on_message(message):
                    nonlocal buffer, finals_accumulated
                    try:
                        if not get_value(message, "channel"):
                            return
                        alt = get_first_alternative(message)
                        if not alt:
                            return
                        text = get_value(alt, "transcript") or ""
                        if not text:
                            return
                        is_final = bool(get_value(message, "is_final", False))
                        speech_final = bool(get_value(message, "speech_final", False))
                        emit_text = f"{buffer} {text}".strip() if buffer else text
                        if is_final:
                            buffer = f"{buffer} {text}".strip()
                            finals_accumulated += 1
                        # Flush a long run of finals so one utterance cannot grow forever.
                        if speech_final or finals_accumulated >= 30:
                            emit_text = buffer
                            buffer = ""
                            finals_accumulated = 0
                            speech_final = True
                        language = detect_message_language(alt) if is_multi else cycle_language
                        emit_transcript(speech_final, emit_text, language)
                    except Exception as error:
                        print(f"Deepgram message error: {error}", file=sys.stderr, flush=True)

                def on_error(error):
                    print(f"Deepgram connection error: {error}", file=sys.stderr, flush=True)

                def on_open(_):
                    print("Deepgram connection opened.", file=sys.stderr, flush=True)

                def on_close(_):
                    connection_closed.set()
                    print("Deepgram connection closed.", file=sys.stderr, flush=True)

                connection.on(EventType.MESSAGE, on_message)
                connection.on(EventType.ERROR, on_error)
                connection.on(EventType.OPEN, on_open)
                connection.on(EventType.CLOSE, on_close)

                def close_stream():
                    try:
                        connection.send_control(ListenV1ControlMessage(type="CloseStream"))
                    except Exception as error:
                        print(f"Deepgram close stream error: {error}", file=sys.stderr, flush=True)

                def sender_worker():
                    while not stop_event.is_set() and not connection_closed.is_set():
                        if restart_event.is_set():
                            close_stream()
                            break
                        try:
                            data = audio_queue.get(timeout=0.1)
                        except QueueEmpty:
                            continue
                        if restart_event.is_set():
                            close_stream()
                            break
                        try:
                            connection.send_media(data)
                        except Exception as error:
                            print(f"Deepgram send error: {error}", file=sys.stderr, flush=True)
                            break
                    sender_done.set()

                sender_thread = threading.Thread(target=sender_worker, daemon=True)
                sender_thread.start()
                connection.start_listening()

                while not (stop_event.is_set() or connection_closed.is_set()
                           or sender_done.is_set() or restart_event.is_set()):
                    time.sleep(0.1)

        except Exception as error:
            print(f"Error during Deepgram connection cycle: {error}", file=sys.stderr, flush=True)
            time.sleep(1)
        finally:
            if sender_thread and sender_thread.is_alive():
                sender_done.wait(timeout=1)


reader_thread = threading.Thread(target=deepgram_stt_stream, daemon=True)
reader_thread.start()

command_thread = threading.Thread(target=listen_for_commands, daemon=True)
command_thread.start()

print("Starting GStreamer pipeline and Deepgram STT...", file=sys.stderr, flush=True)
pipeline.set_state(Gst.State.PLAYING)

mainloop = GLib.MainLoop()
try:
    mainloop.run()
except KeyboardInterrupt:
    pass

stop_event.set()
pipeline.set_state(Gst.State.NULL)
