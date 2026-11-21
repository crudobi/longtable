package kitchen.longtable.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins (not npm packages), registered before super so
        // the bridge knows them when the web view starts asking:
        // LocalApi is the localhost API's native socket half;
        // SecureStore is the Keystore-backed secret storage (Wave 3).
        registerPlugin(LocalApiPlugin.class);
        registerPlugin(SecureStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
