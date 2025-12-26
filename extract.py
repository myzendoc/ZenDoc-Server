import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GLib
import sys
from queue import Queue, Empty as QueueEmpty
import threading
import json
import os

audio_queue = Queue(maxsize=200)
language_code = sys.argv[6]

Gst.init(None)

pipeline_str = """
rtpbin name=rtpbin latency=10 buffer-mode=0
udpsrc port={audio_remote_rtp_port} caps="{audio_caps}" ! rtpbin.recv_rtp_sink_0 rtpbin. ! rtpopusdepay ! opusdec plc=false ! queue max-size-buffers=20 max-size-time=0 max-size-bytes=0 ! audioconvert ! audioresample ! audio/x-raw, format=S16LE, rate=16000, channels=1 ! appsink name=audio_sink emit-signals=true sync=false max-buffers=20 drop=false
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


def on_new_sample(sink):
    sample = sink.emit("pull-sample")
    buf = sample.get_buffer()
    data = buf.extract_dup(0, buf.get_size())

    audio_queue.put(data)
    return Gst.FlowReturn.OK

appsink.connect("new-sample", on_new_sample)

def deepgram_stt_stream(): 
    try:
        from deepgram import DeepgramClient
        from deepgram.core.events import EventType
    except ImportError:
        print("Failed to import Deepgram. Please run:", file=sys.stderr, flush=True)
        print("pip install deepgram-sdk", file=sys.stderr, flush=True)
        return

    if os.getenv("DEEPGRAM_API_KEY") is None:
        print("DEEPGRAM_API_KEY environment variable not set. Exiting.", file=sys.stderr, flush=True)
        return

    while True:
        sender_thread = None
        
        try:
            deepgram = DeepgramClient()

            with deepgram.listen.v1.connect(
                 model="nova-3",
                encoding="linear16",
                sample_rate="16000",
                interim_results=True,
                language=language_code,
                endpointing=300
            ) as connection:
                print(f"Connecting to Deepgram", file=sys.stderr, flush=True)

                def on_message(message):
                    try:
                        if not hasattr(message, "channel"):
                            return

                        alt = message.channel.alternatives[0]
                        text = alt.transcript or ""
                        if not text:
                            return

                        is_final = message.is_final

                        print(
                            json.dumps({"isFinal": is_final, "text": text}),
                            flush=True
                        )

                    except Exception as e:
                        pass


                def on_error(error):
                    print(f"Deepgram connection error: {error}", file=sys.stderr, flush=True)
                
                def on_open(_):
                    print(f"Deepgram connection opened.", file=sys.stderr, flush=True)
                
                def on_close(_):
                    print(f"Deepgram connection closed.", file=sys.stderr, flush=True)

                connection.on(EventType.MESSAGE, on_message)
                connection.on(EventType.ERROR, on_error)
                connection.on(EventType.OPEN, on_open)
                connection.on(EventType.CLOSE, on_close)

                def sender_worker():
                    while True:
                      
                        try:
                            data = audio_queue.get(block=True)
                            
                            if data is None:
                                break
                            
                            connection.send_media(data)

                        except QueueEmpty:
                            continue
                        except Exception as e:
                            print(f"Error in sender thread: {e}", file=sys.stderr, flush=True)
                            break
                    print("Sender thread exiting.", file=sys.stderr, flush=True)

                sender_thread = threading.Thread(target=sender_worker, daemon=True)
                sender_thread.start()

                connection.start_listening()
                
                if sender_thread:
                    sender_thread.join()

        except Exception as e:
            print(f"Error during Deepgram connection cycle: {e}", file=sys.stderr, flush=True)
            print("Retrying connection", file=sys.stderr, flush=True)



reader_thread = threading.Thread(target=deepgram_stt_stream, daemon=True)
reader_thread.start()

def listen_for_commands():
    global language_code

    for line in sys.stdin:
        line = line.strip()

        if line.startswith("CHANGE_LANG"):
            parts = line.split(" ")
            if len(parts) == 2:
                new_lang = parts[1]
                if language_code != new_lang:
                    language_code = new_lang

command_thread = threading.Thread(target=listen_for_commands, daemon=True)
command_thread.start()

print("Starting GStreamer pipeline and Deepgram STT...", file=sys.stderr, flush=True)
pipeline.set_state(Gst.State.PLAYING)

mainloop = GLib.MainLoop()
try:
    mainloop.run()
except KeyboardInterrupt:
    pass

pipeline.set_state(Gst.State.NULL)
