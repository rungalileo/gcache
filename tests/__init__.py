import socket


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        # Bind to port 0 to let the OS pick a free port.
        s.bind(("", 0))
        # Retrieve the assigned port number.
        free_port = s.getsockname()[1]
    return free_port
