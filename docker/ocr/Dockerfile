# Thin image on the official PaddleX CPU image: the base lacks the
# serving plugin, PaddleX serving is an optional extra.
FROM ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlex/paddlex:paddlex3.3.11-paddlepaddle3.2.0-cpu

RUN pip install --no-cache-dir "paddlex[serving]==3.3.11"

EXPOSE 8080
CMD ["paddlex", "--serve", "--pipeline", "OCR"]
