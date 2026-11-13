package ar.gastos.app;

import android.app.Notification;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Mira las notificaciones que llegan y se queda solo con las que parecen un movimiento de plata
 * (tienen un importe en pesos y una palabra como "pagaste" o "transferencia").
 * Todo lo demás se descarta en el momento, sin guardarlo. Nada sale del teléfono.
 */
public class Lector extends NotificationListenerService {
    private static final Pattern IMPORTE = Pattern.compile("\\$\\s?\\d");
    private static final Pattern MOVIMIENTO = Pattern.compile(
            "pagaste|pago|compra|consumo|transfer|recibiste|te envi|enviaste|d[eé]bito|debitamos|acreditamos|acredit[oó]|extracci[oó]n|ingres[oó]|cobraste",
            Pattern.CASE_INSENSITIVE);
    // Apps de mensajes y correo: nunca se leen, aunque alguien escriba un importe.
    private static final Set<String> NUNCA = new HashSet<>(Arrays.asList(
            "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "com.google.android.apps.messaging",
            "com.samsung.android.messaging", "com.instagram.android", "com.facebook.orca", "com.facebook.katana",
            "com.google.android.gm", "com.microsoft.office.outlook", "com.discord", "com.slack", "com.twitter.android"));

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String paquete = sbn.getPackageName();
            if (paquete == null || paquete.equals(getPackageName()) || NUNCA.contains(paquete)) return;
            if (Cola.bloqueadas(this).contains(paquete)) return;

            Bundle x = sbn.getNotification().extras;
            if (x == null) return;
            String titulo = texto(x.getCharSequence(Notification.EXTRA_TITLE));
            CharSequence largo = x.getCharSequence(Notification.EXTRA_BIG_TEXT);
            String cuerpo = texto(largo != null ? largo : x.getCharSequence(Notification.EXTRA_TEXT));
            String todo = titulo + " " + cuerpo;
            if (!IMPORTE.matcher(todo).find() || !MOVIMIENTO.matcher(todo).find()) return;

            Cola.agregar(this, paquete, nombreApp(paquete), titulo, cuerpo, sbn.getPostTime());
        } catch (Exception ignorada) {
            // Una notificación rara no tiene que tirar abajo el servicio.
        }
    }

    private static String texto(CharSequence c) {
        return c == null ? "" : c.toString().trim();
    }

    private String nombreApp(String paquete) {
        try {
            PackageManager pm = getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(paquete, 0)).toString();
        } catch (Exception e) {
            return paquete;
        }
    }
}
