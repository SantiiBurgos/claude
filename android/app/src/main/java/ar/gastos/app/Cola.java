package ar.gastos.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/** Movimientos detectados en notificaciones, a la espera de que el usuario los confirme en la app. */
final class Cola {
    private static final String PREFS = "cola";
    private static final int MAXIMO = 100;

    private Cola() {}

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized String leer(Context c) {
        return prefs(c).getString("items", "[]");
    }

    static synchronized void agregar(Context c, String paquete, String app, String titulo, String texto, long hora) {
        try {
            JSONArray items = new JSONArray(leer(c));
            // Las apps suelen repetir o actualizar la misma notificación: no la guardamos dos veces.
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.getJSONObject(i);
                if (paquete.equals(o.optString("paquete")) && titulo.equals(o.optString("titulo")) && texto.equals(o.optString("texto"))
                        && Math.abs(hora - o.optLong("hora")) < 10 * 60 * 1000) return;
            }
            JSONObject n = new JSONObject();
            n.put("id", paquete + "|" + hora);
            n.put("paquete", paquete);
            n.put("app", app);
            n.put("titulo", titulo);
            n.put("texto", texto);
            n.put("hora", hora);
            items.put(n);
            while (items.length() > MAXIMO) items.remove(0);
            prefs(c).edit().putString("items", items.toString()).apply();
        } catch (Exception ignorada) {
            // Si el guardado está dañado, se empieza de cero en vez de fallar.
            prefs(c).edit().putString("items", "[]").apply();
        }
    }

    static synchronized void quitar(Context c, String id) {
        try {
            JSONArray items = new JSONArray(leer(c)), quedan = new JSONArray();
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.getJSONObject(i);
                if (!id.equals(o.optString("id"))) quedan.put(o);
            }
            prefs(c).edit().putString("items", quedan.toString()).apply();
        } catch (Exception ignorada) {
        }
    }

    static synchronized Set<String> bloqueadas(Context c) {
        return new HashSet<>(prefs(c).getStringSet("bloqueadas", new HashSet<>()));
    }

    static synchronized void bloquear(Context c, String paquete) {
        Set<String> b = bloqueadas(c);
        b.add(paquete);
        prefs(c).edit().putStringSet("bloqueadas", b).apply();
        try {
            JSONArray items = new JSONArray(leer(c)), quedan = new JSONArray();
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.getJSONObject(i);
                if (!paquete.equals(o.optString("paquete"))) quedan.put(o);
            }
            prefs(c).edit().putString("items", quedan.toString()).apply();
        } catch (Exception ignorada) {
        }
    }
}
