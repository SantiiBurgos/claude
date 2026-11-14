package ar.gastos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;

/**
 * Pantalla invisible que recibe lo compartido desde otra app. Lee el archivo en el momento
 * (mientras tiene permiso para hacerlo), lo deja en memoria y trae al frente la única ventana de Gastos.
 */
public class CompartirActivity extends Activity {
    private static final int MAXIMO = 15 * 1024 * 1024;

    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        Intent i = getIntent();
        if (i != null && Intent.ACTION_SEND.equals(i.getAction())) {
            String asunto = i.getStringExtra(Intent.EXTRA_SUBJECT), texto = i.getStringExtra(Intent.EXTRA_TEXT);
            String todo = ((asunto == null ? "" : asunto + " ") + (texto == null ? "" : texto)).trim();
            byte[] datos = null;
            String mime = "";
            Uri u = i.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) {
                try (InputStream in = getContentResolver().openInputStream(u)) {
                    ByteArrayOutputStream o = new ByteArrayOutputStream();
                    byte[] b = new byte[65536];
                    int n;
                    while ((n = in.read(b)) > 0 && o.size() < MAXIMO) o.write(b, 0, n);
                    if (o.size() < MAXIMO) {
                        datos = o.toByteArray();
                        String m = getContentResolver().getType(u);
                        mime = m != null ? m : (i.getType() != null ? i.getType() : "");
                    }
                } catch (Exception ignorada) {
                }
            }
            Compartido.dejar(new Compartido(todo, mime, datos));
        }
        // MainActivity es singleTask: esto la trae al frente (o la crea) sin abrir una segunda copia.
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }
}
