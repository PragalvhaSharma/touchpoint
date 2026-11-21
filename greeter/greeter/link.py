"""The line to the Arduino.

Same protocol as the SafeStop plan: "H" every 50 ms as a heartbeat, plus one
line per event. Here the event is "P <name>" when someone is recognized.
Mock prints events now; Serial talks to the real board later
(--serial /dev/serusb1 on QNX, /dev/ttyACM0 on Linux).
"""
import time


class MockLink:
    def heartbeat(self):
        pass

    def send(self, line: str):
        print(f"[arduino] <- {line}")


class SerialLink:
    def __init__(self, port: str, baud: int = 115200):
        import serial
        self.port = serial.Serial(port, baud, timeout=0)
        time.sleep(2)  # opening the port resets an Uno
        self.last = 0.0

    def heartbeat(self):
        if time.monotonic() - self.last >= 0.05:
            self.port.write(b"H\n")
            self.last = time.monotonic()

    def send(self, line: str):
        self.port.write(line.encode() + b"\n")
