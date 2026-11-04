import com.intellij.air.frontend.llm.impl.byok.AirByokMetadataStoreImpl;
import com.intellij.air.frontend.llm.impl.byok.StoredAirByok;
import com.intellij.air.frontend.llm.api.AirByokId;
import com.intellij.air.frontend.llm.providers.openai.OpenAiByokProvider;
import kotlinx.serialization.KSerializer;
import kotlinx.serialization.json.Json;
import java.lang.reflect.InvocationTargetException;
public class AirSchemaProbe {
  public static void main(String[] args) throws Exception {
    KSerializer<AirByokMetadataStoreImpl.PersistentState> serializer=AirByokMetadataStoreImpl.PersistentState.Companion.serializer();
    String uuid="12345678-1234-4234-9234-123456789abc";
    String input="{\"entries\":[{\"id\":\""+uuid+"\",\"type\":\"openai\",\"name\":\"ModelDock Rider\",\"settings\":[{\"key\":\"baseUrl\",\"value\":\"http://127.0.0.1:18181/tool/rider/v1\"}]}]}";
    AirByokMetadataStoreImpl.PersistentState value=Json.Default.decodeFromString(serializer,input);
    if(value.entries.size()!=1)throw new AssertionError("entries count");
    StoredAirByok entry=value.entries.get(0);
    if(!entry.id.equals(uuid)||!entry.type.equals("openai")||!entry.settings.get(0).key.equals("baseUrl")||!entry.settings.get(0).value.equals("http://127.0.0.1:18181/tool/rider/v1"))throw new AssertionError("serialized fields");
    if(entry.baseUrl!=null||entry.organization!=null||entry.project!=null||entry.region!=null||!entry.headers.isEmpty())throw new AssertionError("defaults");
    String output=Json.Default.encodeToString(serializer,value);
    if(!output.equals(input))throw new AssertionError("roundtrip output: "+output);
    if(!Json.Default.decodeFromString(serializer,"{}").entries.isEmpty())throw new AssertionError("empty default");
    var parse=AirByokId.Companion.getClass().getMethod("parse-vGq7qbs",String.class);
    if(!parse.invoke(AirByokId.Companion,uuid).equals(uuid))throw new AssertionError("valid native id");
    try{parse.invoke(AirByokId.Companion,"modeldock-rider-fixture");throw new AssertionError("native id validation");}catch(InvocationTargetException expected){if(!(expected.getCause() instanceof IllegalArgumentException))throw expected;}
    OpenAiByokProvider provider=new OpenAiByokProvider();
    if(!provider.getId().equals("openai"))throw new AssertionError("provider identity");
    if(!provider.usesApiKey(java.util.Map.of("baseUrl","http://127.0.0.1:18181/tool/rider/v1")))throw new AssertionError("native provider requires credential");
    System.out.println("AIR_SCHEMA_OK "+output);
  }
}
