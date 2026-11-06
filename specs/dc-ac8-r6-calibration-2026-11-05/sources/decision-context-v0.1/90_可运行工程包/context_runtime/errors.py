"""Stable public faults shared by runtime and durable checkpoint adapter."""


class RuntimeFault(ValueError):
    def __init__(self, code, message, retryable=False):
        self.code, self.retryable = code, retryable
        super().__init__(message)


def check(value, code, message, retryable=False):
    if not value:
        raise RuntimeFault(code, message, retryable)
