package ar.gastos.app;

/** Lo último que llegó por "Compartir", a la espera de que la ventana principal lo levante. */
final class Compartido {
    final String texto;
    final String mime;
    final byte[] datos;

    private static Compartido pendiente;

    Compartido(String texto, String mime, byte[] datos) {
        this.texto = texto;
        this.mime = mime;
        this.datos = datos;
    }

    static synchronized void dejar(Compartido c) {
        pendiente = c;
    }

    /** Devuelve lo pendiente y lo borra, para que no se procese dos veces. */
    static synchronized Compartido tomar() {
        Compartido c = pendiente;
        pendiente = null;
        return c;
    }
}
