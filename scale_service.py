# scale_service.py  –  run with:  python scale_service.py
import threading, serial, re, time, os
from datetime import datetime
from flask import Flask, jsonify, make_response
from collections import OrderedDict
from flask_cors import CORS

# -----------  CONFIG  -----------
PORT      = os.getenv("SCALE_COM", "COM7")
BAUD      = int(os.getenv("SCALE_BAUD", "1200"))
TIMEOUT   = 1                 # seconds for serial.readline
MODE_AUTO = False             # True if your scale is in AUTO stream mode

# -----------  REGEX  -----------
RE_SN  = re.compile(r"SN\.(\d+)")
RE_NET = re.compile(r"NET:\s*([-\d.]+)\s*kg", re.I)
RE_UW  = re.compile(r"U/W:\s*([-\d.]+)\s*g",  re.I)
RE_PCS = re.compile(r"PCS:\s*(\d+)",          re.I)

latest_record = None          # shared state; holds dict or None
record_lock   = threading.Lock()

# -----------  SERIAL READER  -----------
def reader():
    """Background thread: read tickets, keep only the newest one."""
    global latest_record
    print(f"[SCALE] opening {PORT} @ {BAUD} bps …")
    with serial.Serial(PORT, BAUD, timeout=TIMEOUT) as ser:
        ser.setDTR(True); ser.setRTS(True)
        buf = []

        while True:
            raw = ser.readline().decode("ascii", "ignore").rstrip("\r\n")
            if not raw:
                continue

            if MODE_AUTO:
                # AUTO mode: each frame is one line:  '... pcs'
                rec = parse_ticket([raw])
                if rec:
                    with record_lock:
                        latest_record = rec
                continue

            # MANU-P mode: build a 4/5-line ticket ending with 'PCS:'
            buf.append(raw)
            if raw.lstrip().startswith("PCS:"):
                rec = parse_ticket(buf)
                buf = []               # reset for next ticket
                if rec:
                    with record_lock:
                        latest_record = rec
                        print(latest_record)

def parse_ticket(lines):
    joined = "\n".join(lines)
    m_sn  = RE_SN.search(joined)
    m_net = RE_NET.search(joined)
    m_uw  = RE_UW.search(joined)
    m_pcs = RE_PCS.search(joined)

    if not all((m_sn, m_net, m_uw, m_pcs)):
        return None

    # build in the exact order you want
    return OrderedDict([
        ("timestamp"     , datetime.now().isoformat(timespec="seconds")),
        ("serial_no"     , int(m_sn.group(1))),
        ("net_kg"        , float(m_net.group(1))),
        ("unit_weight_g" , float(m_uw.group(1))),
        ("pcs"           , int(m_pcs.group(1))),
    ])

# -----------  START READER THREAD  -----------
threading.Thread(target=reader, daemon=True).start()

# -----------  FLASK API  -----------
app = Flask(__name__)
CORS(app)

app.config["JSON_SORT_KEYS"] = False      # ? stop Flask re-sorting
@app.route("/get_weight", methods=["GET"])
def get_weight():
    with record_lock:
        if latest_record is None:
            # no ticket yet ? HTTP 204 No Content
            return make_response("", 204)
        return jsonify(latest_record)

@app.route("/status", methods=["GET"])
def status():
    return (
        "Scale service is running. "
        "Call /get_weight for the newest record."
    )

# -----------  MAIN  -----------
if __name__ == "__main__":
    # dev server (single process) – avoids double-opening the COM port
    app.run(host="0.0.0.0", port=8000, debug=False, use_reloader=False)