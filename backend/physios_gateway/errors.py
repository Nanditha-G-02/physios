"""Structured API errors: every failure leaves the gateway as
``{"error": {"code": ..., "message": ..., "hint": ...}}`` with a matching HTTP status."""


class ApiError(Exception):

    def __init__(self, status, code, message, hint=None, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.hint = hint
        self.details = details

    def body(self):
        err = {'code': self.code, 'message': self.message}
        if self.hint:
            err['hint'] = self.hint
        if self.details is not None:
            err['details'] = self.details
        return {'error': err}


def bad_request(message, hint=None):
    return ApiError(400, 'bad_request', message, hint)


def not_found(message):
    return ApiError(404, 'not_found', message)
