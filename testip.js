const axios = require("axios");
const checkdevices = async () => {
    for (let i = 1; i < 256; i++) {
        try {
            const response = await axios.post("http://localhost:5001/api/connect", {
                xaddr: `http://192.168.29.${i}:8000/onvif/device_service`,
                user: "admin",
                pass: "devs3100"
            });
            console.log(response.data);
        } catch (e) {
            console.log(`Failed for 192.168.29.${i}`);
        }
    }
}
checkdevices();