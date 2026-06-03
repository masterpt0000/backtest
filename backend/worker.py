"""
RQ worker for chart jobs.

Run from backend directory:
    python worker.py
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from rq import SimpleWorker, Worker

from job_queue import queue_name, redis_conn

load_dotenv(Path(__file__).resolve().parent / ".env")


def main() -> None:
    conn = redis_conn()
    queues = [queue_name()]
    worker_cls = SimpleWorker if os.name == "nt" else Worker
    worker = worker_cls(queues, connection=conn)
    worker.work(with_scheduler=False)


if __name__ == "__main__":
    main()
