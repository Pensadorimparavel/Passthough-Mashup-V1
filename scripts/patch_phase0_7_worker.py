from pathlib import Path
p = Path("src/workers/emulator.worker.js")
s = p.read_text(encoding="utf-8")
marker = '    if (type === "setMemoryWriteEnabled") {'
if 'if (type === "readMemoryRange")' not in s:
    code = """    // Fase 0.7 — bounded bulk read for the read-only memory probe.
    // Only EWRAM and IWRAM are accepted; no write API is exposed here.
    if (type === "readMemoryRange") {
      const address = Number(message.address) >>> 0;
      const length = Number(message.length);
      const isEwram = address >= 0x02000000 && length >= 1 && length <= 0x40000 && length <= 0x02040000 - address;
      const isIwram = address >= 0x03000000 && length >= 1 && length <= 0x8000 && length <= 0x03008000 - address;
      if (!Number.isInteger(length) || (!isEwram && !isIwram)) {
        throw new Error("readMemoryRange: somente EWRAM/IWRAM e até 256 KiB por leitura.");
      }
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = moduleInstance._mgba_read_memory8(coreHandle, address + i) & 0xff;
      }
      reply(id, true, { type: "memoryRange", address, length, bytes: bytes.buffer }, [bytes.buffer]);
      return;
    }

"""
    if marker not in s:
        raise SystemExit("Worker marker not found; refusing to patch.")
    s = s.replace(marker, code + marker, 1)
    p.write_text(s, encoding="utf-8")
