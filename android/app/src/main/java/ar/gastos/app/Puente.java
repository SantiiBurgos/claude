package ar.gastos.app;

import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Lo que la página puede pedirle a la parte nativa. Se expone en JavaScript como window.Android. */
final class Puente {
    private final MainActivity act;

    Puente(MainActivity act) {
        this.act = act;
    }

    @JavascriptInterface
    public int version() {
        return 3;
    }

    // ----- notificaciones -----

    /** Indica si esta variante de la app incluye la lectura de notificaciones. */
    @JavascriptInterface
    public boolean tieneLector() {
        try {
            act.getPackageManager().getServiceInfo(new ComponentName(act, "ar.gastos.app.Lector"), 0);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public boolean permiso() {
        String s = Settings.Secure.getString(act.getContentResolver(), "enabled_notification_listeners");
        return s != null && s.contains(act.getPackageName() + "/");
    }

    @JavascriptInterface
    public void pedirPermiso() {
        try {
            act.startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
        } catch (Exception e) {
            aviso("Buscá \"Acceso a notificaciones\" en los Ajustes del teléfono");
        }
    }

    @JavascriptInterface
    public String pendientes() {
        return Cola.leer(act);
    }

    @JavascriptInterface
    public void descartar(String id) {
        Cola.quitar(act, id);
    }

    @JavascriptInterface
    public void bloquear(String paquete) {
        Cola.bloquear(act, paquete);
    }

    // ----- archivos: respaldo y planilla -----

    private Uri escribir(String nombre, String mime, String contenido) throws Exception {
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, nombre);
        v.put(MediaStore.Downloads.MIME_TYPE, mime);
        Uri u = act.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (u == null) throw new Exception("sin destino");
        try (OutputStream o = act.getContentResolver().openOutputStream(u)) {
            o.write(contenido.getBytes(StandardCharsets.UTF_8));
        }
        return u;
    }

    /** Guarda un archivo en la carpeta Descargas del teléfono. */
    @JavascriptInterface
    public boolean guardar(String nombre, String mime, String contenido) {
        try {
            escribir(nombre, mime, contenido);
            aviso("Guardado en Descargas: " + nombre);
            return true;
        } catch (Exception e) {
            aviso("No se pudo guardar el archivo");
            return false;
        }
    }

    /** Guarda el archivo en Descargas y abre el menú Compartir para mandarlo a Drive, WhatsApp, mail, etc. */
    @JavascriptInterface
    public boolean compartir(String nombre, String mime, String contenido) {
        try {
            Uri u = escribir(nombre, mime, contenido);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType(mime);
            i.putExtra(Intent.EXTRA_STREAM, u);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            act.startActivity(Intent.createChooser(i, "Guardar respaldo en…"));
            return true;
        } catch (Exception e) {
            aviso("No se pudo compartir el archivo");
            return false;
        }
    }

    // ----- lo que llegó por "Compartir" desde otra app -----

    @JavascriptInterface
    public boolean hayCompartido() {
        return act.hayCompartido;
    }

    @JavascriptInterface
    public String compartidoTexto() {
        return act.compTexto;
    }

    @JavascriptInterface
    public String compartidoMime() {
        return act.compMime;
    }

    @JavascriptInterface
    public String compartidoDatos() {
        byte[] d = act.compDatos;
        return d == null ? "" : Base64.encodeToString(d, Base64.NO_WRAP);
    }

    @JavascriptInterface
    public void compartidoListo() {
        act.hayCompartido = false;
        act.compDatos = null;
        act.compTexto = "";
        act.compMime = "";
    }

    private void aviso(String texto) {
        act.runOnUiThread(() -> Toast.makeText(act, texto, Toast.LENGTH_LONG).show());
    }
}
